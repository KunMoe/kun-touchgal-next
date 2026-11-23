import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  verifyHeaderCookieMock,
  userFindUniqueMock,
  resourceFindFirstMock,
  checkKunCaptchaExistMock,
  presignPutObjectMock,
  setKvMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  resourceFindFirstMock: vi.fn(),
  checkKunCaptchaExistMock: vi.fn(),
  presignPutObjectMock: vi.fn(),
  setKvMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock },
    patch_resource: { findFirst: resourceFindFirstMock }
  }
}))

vi.mock('~/app/api/utils/verifyKunCaptcha', () => ({
  checkKunCaptchaExist: checkKunCaptchaExistMock
}))

vi.mock('~/lib/s3', () => ({
  presignPutObject: presignPutObjectMock
}))

vi.mock('~/lib/redis', () => ({
  setKv: setKvMock
}))

import { POST } from '~/app/api/upload/init/route'

const UID = 7
const MB = 1024 * 1024
const PRESIGNED_URL = 'https://s3.example.com/presigned'
const CAPTCHA = 'captcha-token'

const PERMISSION_ERROR =
  '您的权限不足, 创作者或者管理员才可以上传文件到对象存储'
const MOEMOEPOINT_ERROR = '仅限萌萌点大于 20 的用户才可以发布资源'
const CAPTCHA_ERROR = '人机验证无效, 请完成人机验证'
const QUOTA_ERROR = '您今日的上传大小已达到 5GB 限额'
const PENDING_ERROR =
  '您有至少一个 Galgame 资源在待审核阶段, 请等待审核结束后再发布资源'
const NAME_ERROR =
  '文件名不可用: 仅支持 .zip .rar .7z 格式, 且文件名需要包含文字或数字, 请改名后重新上传'

const validBody = (): Record<string, unknown> => ({
  fileName: 'game.zip',
  fileSize: MB,
  captcha: CAPTCHA
})

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/upload/init', {
    method: 'POST',
    body: JSON.stringify(body)
  })

const asPayload = (role: number) => ({ uid: UID, name: 'kun', role })

const asUserRow = (overrides: Record<string, unknown> = {}) => ({
  id: UID,
  role: 2,
  moemoepoint: 20,
  daily_upload_size: 0,
  ...overrides
})

// 会话 role 与库内 role 默认一致; 需要两者分歧时分别传入
const signInAs = (dbRow: Record<string, unknown>, payloadRole?: number) => {
  const row = asUserRow(dbRow)
  verifyHeaderCookieMock.mockResolvedValue(
    asPayload(payloadRole ?? (row.role as number))
  )
  userFindUniqueMock.mockResolvedValue(row)
}

const expectSucceeded = async (res: Response) => {
  const body = await res.json()
  expect(body).toEqual({
    uploadUrl: PRESIGNED_URL,
    token: expect.any(String),
    expiresIn: 7200
  })
  expect(presignPutObjectMock).toHaveBeenCalledTimes(1)
}

beforeEach(() => {
  vi.resetAllMocks()
  signInAs({})
  resourceFindFirstMock.mockResolvedValue(null)
  checkKunCaptchaExistMock.mockResolvedValue(true)
  presignPutObjectMock.mockResolvedValue(PRESIGNED_URL)
  setKvMock.mockResolvedValue(undefined)
})

describe('POST /api/upload/init 前置闸门顺序', () => {
  it('请求体非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(postRequest({ ...validBody(), fileSize: 1023 }))

    expect(res.status).toBe(200)
    expect(await res.json()).toBe('文件过小, 您的文件小于 1 KB')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
  })

  it('文件不小于 1GB 时返回对象存储上限消息', async () => {
    const res = await POST(postRequest({ ...validBody(), fileSize: 1024 * MB }))

    expect(await res.json()).toBe('文件大小超过限制, 必须小于 1GB')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未认证, 不查用户行', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(postRequest(validBody()))

    expect(await res.json()).toBe('用户未认证')
    expect(userFindUniqueMock).not.toHaveBeenCalled()
  })

  it('未登录且文件名不可用时鉴权消息优先', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(postRequest({ ...validBody(), fileName: 'a.exe' }))

    expect(await res.json()).toBe('用户未认证')
  })

  it.each([
    ['扩展名不在白名单', 'a.exe'],
    ['白名单扩展名不在末尾', 'game.zip.exe'],
    ['没有扩展名', 'archive'],
    ['扩展名后跟着空格', 'game.zip '],
    ['主名为空', '.zip'],
    ['主名只有符号', '【】.zip'],
    ['主名全是 emoji', '😀❤\ufe0f.zip']
  ])('%s的文件名被拒, 先于查用户行与人机验证', async (_, fileName) => {
    const res = await POST(postRequest({ ...validBody(), fileName }))

    expect(await res.json()).toBe(NAME_ERROR)
    expect(userFindUniqueMock).not.toHaveBeenCalled()
    expect(checkKunCaptchaExistMock).not.toHaveBeenCalled()
    expect(presignPutObjectMock).not.toHaveBeenCalled()
  })

  it.each(['GAME.ZIP', 'game.rar', 'game.7z'])(
    '扩展名 %s 按小写比对后通过白名单',
    async (fileName) => {
      signInAs({ role: 3 })
      const res = await POST(postRequest({ ...validBody(), fileName }))

      await expectSucceeded(res)
    }
  )

  it('用户行不存在返回 用户未找到, 按会话 uid 查库', async () => {
    userFindUniqueMock.mockResolvedValue(null)
    const res = await POST(postRequest(validBody()))

    expect(await res.json()).toBe('用户未找到')
    expect(userFindUniqueMock).toHaveBeenCalledWith({ where: { id: UID } })
    expect(checkKunCaptchaExistMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/upload/init 角色矩阵 (按库内 user.role)', () => {
  it.each([
    { role: 1, expected: PERMISSION_ERROR },
    { role: 2, expected: MOEMOEPOINT_ERROR },
    { role: 3, expected: null },
    { role: 4, expected: null }
  ])(
    '萌萌点 0 时 role $role 的结果 (role >= 3 豁免萌萌点)',
    async ({ role, expected }) => {
      signInAs({ role, moemoepoint: 0 })
      const res = await POST(postRequest(validBody()))

      if (expected === null) {
        await expectSucceeded(res)
      } else {
        expect(await res.json()).toBe(expected)
        expect(presignPutObjectMock).not.toHaveBeenCalled()
      }
    }
  )

  it.each([
    { role: 2, moemoepoint: 19, expected: MOEMOEPOINT_ERROR },
    { role: 2, moemoepoint: 20, expected: null },
    { role: 3, moemoepoint: 19, expected: null },
    { role: 4, moemoepoint: 19, expected: null }
  ])(
    '萌萌点边界: role $role 萌萌点 $moemoepoint',
    async ({ role, moemoepoint, expected }) => {
      signInAs({ role, moemoepoint })
      const res = await POST(postRequest(validBody()))

      if (expected === null) {
        await expectSucceeded(res)
      } else {
        expect(await res.json()).toBe(expected)
        expect(presignPutObjectMock).not.toHaveBeenCalled()
      }
    }
  )

  it('role 1 即使萌萌点充足也被拒', async () => {
    signInAs({ role: 1, moemoepoint: 1000 })
    const res = await POST(postRequest(validBody()))

    expect(await res.json()).toBe(PERMISSION_ERROR)
    expect(checkKunCaptchaExistMock).not.toHaveBeenCalled()
  })

  it.each([
    { role: 1, expected: PERMISSION_ERROR, captchaChecked: false },
    { role: 2, expected: CAPTCHA_ERROR, captchaChecked: true },
    { role: 3, expected: null, captchaChecked: false },
    { role: 4, expected: null, captchaChecked: false }
  ])(
    '人机验证只在 role === 2 时要求: 验证失败时 role $role 的结果',
    async ({ role, expected, captchaChecked }) => {
      signInAs({ role, moemoepoint: 100 })
      checkKunCaptchaExistMock.mockResolvedValue(false)
      const res = await POST(postRequest(validBody()))

      if (expected === null) {
        await expectSucceeded(res)
      } else {
        expect(await res.json()).toBe(expected)
        expect(presignPutObjectMock).not.toHaveBeenCalled()
      }
      if (captchaChecked) {
        expect(checkKunCaptchaExistMock).toHaveBeenCalledWith(CAPTCHA)
      } else {
        expect(checkKunCaptchaExistMock).not.toHaveBeenCalled()
      }
    }
  )

  it('role 2 验证通过后放行', async () => {
    signInAs({ role: 2, moemoepoint: 100 })
    const res = await POST(postRequest(validBody()))

    await expectSucceeded(res)
    expect(checkKunCaptchaExistMock).toHaveBeenCalledWith(CAPTCHA)
  })

  it('role 2 未带 captcha 字段时以空串送检', async () => {
    signInAs({ role: 2, moemoepoint: 100 })
    checkKunCaptchaExistMock.mockResolvedValue(false)
    const { captcha: _captcha, ...body } = validBody()
    const res = await POST(postRequest(body))

    expect(await res.json()).toBe(CAPTCHA_ERROR)
    expect(checkKunCaptchaExistMock).toHaveBeenCalledWith('')
  })

  it('role 2 萌萌点不足时先于人机验证报错, 不消耗验证令牌', async () => {
    signInAs({ role: 2, moemoepoint: 19 })
    checkKunCaptchaExistMock.mockResolvedValue(false)
    const res = await POST(postRequest(validBody()))

    expect(await res.json()).toBe(MOEMOEPOINT_ERROR)
    expect(checkKunCaptchaExistMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/upload/init 会话 role 与库内 role 不一致时以库内为准', () => {
  it('会话 role 4、库内 role 1: 按 1 拒绝', async () => {
    signInAs({ role: 1, moemoepoint: 100 }, 4)
    const res = await POST(postRequest(validBody()))

    expect(await res.json()).toBe(PERMISSION_ERROR)
  })

  it('会话 role 1、库内 role 3: 按 3 放行, 豁免萌萌点且不要求人机验证', async () => {
    signInAs({ role: 3, moemoepoint: 0 }, 1)
    checkKunCaptchaExistMock.mockResolvedValue(false)
    const res = await POST(postRequest(validBody()))

    await expectSucceeded(res)
    expect(checkKunCaptchaExistMock).not.toHaveBeenCalled()
  })

  it('会话 role 3、库内 role 2: 按 2 适用萌萌点闸门', async () => {
    signInAs({ role: 2, moemoepoint: 0 }, 3)
    const res = await POST(postRequest(validBody()))

    expect(await res.json()).toBe(MOEMOEPOINT_ERROR)
  })

  it('会话 role 3、库内 role 2: 按 2 要求人机验证', async () => {
    signInAs({ role: 2, moemoepoint: 100 }, 3)
    checkKunCaptchaExistMock.mockResolvedValue(false)
    const res = await POST(postRequest(validBody()))

    expect(await res.json()).toBe(CAPTCHA_ERROR)
    expect(checkKunCaptchaExistMock).toHaveBeenCalledWith(CAPTCHA)
  })

  it('会话 role 2、库内 role 3: 按 3 不要求人机验证', async () => {
    signInAs({ role: 3, moemoepoint: 100 }, 2)
    checkKunCaptchaExistMock.mockResolvedValue(false)
    const res = await POST(postRequest(validBody()))

    await expectSucceeded(res)
    expect(checkKunCaptchaExistMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/upload/init 每日额度与待审资源', () => {
  it('已用 + 本次恰好等于 5120 MB 时放行', async () => {
    signInAs({ role: 3, daily_upload_size: 5119 })
    const res = await POST(postRequest({ ...validBody(), fileSize: MB }))

    await expectSucceeded(res)
  })

  it.each([2, 3, 4])(
    '超出 5120 MB 时 role %i 同样被拒 (额度无角色豁免), 不查待审资源',
    async (role) => {
      signInAs({ role, moemoepoint: 100, daily_upload_size: 5119 })
      resourceFindFirstMock.mockResolvedValue({ id: 1 })
      const res = await POST(postRequest({ ...validBody(), fileSize: MB + 1 }))

      expect(await res.json()).toBe(QUOTA_ERROR)
      expect(resourceFindFirstMock).not.toHaveBeenCalled()
      expect(presignPutObjectMock).not.toHaveBeenCalled()
    }
  )

  it.each([2, 3, 4])(
    '有待审资源时 role %i 同样被拒 (无角色豁免), 不签发上传地址',
    async (role) => {
      signInAs({ role, moemoepoint: 100 })
      resourceFindFirstMock.mockResolvedValue({ id: 1 })
      const res = await POST(postRequest(validBody()))

      expect(await res.json()).toBe(PENDING_ERROR)
      expect(resourceFindFirstMock).toHaveBeenCalledWith({
        where: { user_id: UID, status: 2 }
      })
      expect(presignPutObjectMock).not.toHaveBeenCalled()
      expect(setKvMock).not.toHaveBeenCalled()
    }
  )
})

describe('POST /api/upload/init 成功响应', () => {
  it('按会话 uid 与净化后的文件名签发暂存 key, 并把令牌写入 Redis', async () => {
    signInAs({ role: 3 })
    const res = await POST(
      postRequest({ ...validBody(), fileName: '游戏 v1.0.zip', fileSize: MB })
    )

    const body = await res.json()
    expect(body).toEqual({
      uploadUrl: PRESIGNED_URL,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      expiresIn: 7200
    })

    expect(presignPutObjectMock).toHaveBeenCalledTimes(1)
    const [s3Key, declared, presignTtl] = presignPutObjectMock.mock.calls[0]
    expect(s3Key).toMatch(
      new RegExp(`^patch/tmp/${UID}/[0-9a-f]{64}/游戏v10\\.zip$`)
    )
    expect(declared).toBe(MB)
    expect(presignTtl).toBe(7200)

    expect(setKvMock).toHaveBeenCalledTimes(1)
    const [kvKey, kvValue, kvTtl] = setKvMock.mock.calls[0]
    expect(kvKey).toBe(`upload:${body.token}`)
    expect(JSON.parse(kvValue)).toEqual({
      s3Key,
      fileName: '游戏v10.zip',
      declared: MB,
      uid: UID
    })
    expect(kvTtl).toBe(24 * 60 * 60)
  })

  // 暂存 key 的末段与令牌里的 fileName 是同一个名字, 后者就是转正后的下载文件名
  const stagedName = async (fileName: string) => {
    signInAs({ role: 3 })
    const res = await POST(postRequest({ ...validBody(), fileName }))
    expect(await res.json()).toMatchObject({ uploadUrl: PRESIGNED_URL })

    const [s3Key] = presignPutObjectMock.mock.calls[0]
    const name = (s3Key as string).split('/').pop()
    expect(JSON.parse(setKvMock.mock.calls[0][1]).fileName).toBe(name)
    return name!
  }

  it('macOS 交来的分解形式文件名先合成再清洗, 浊点不丢', async () => {
    const name = await stagedName('ガールズ&パッチ.zip'.normalize('NFD'))

    expect(name).toBe('ガールズパッチ.zip')
  })

  it('文件名里的换行与路径片段进不了 key', async () => {
    const name = await stagedName('a\n../../b.zip')

    expect(name).toBe('ab.zip')
  })

  it('平面外文字的长文件名按码点截断, key 仍是合法字符串, 不再让预签名抛错', async () => {
    const name = await stagedName(`a${'𠮷'.repeat(120)}.zip`)

    expect(name).toBe(`a${'𠮷'.repeat(99)}.zip`)
    expect(name.isWellFormed()).toBe(true)
  })

  it('大写扩展名落成白名单里的小写形式', async () => {
    const name = await stagedName('GAME.ZIP')

    expect(name).toBe('GAME.zip')
  })
})
