import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  verifyHeaderCookieMock,
  userFindUniqueMock,
  resourceFindFirstMock,
  acquireKvLockMock,
  releaseKvLockMock,
  createPatchResourceMock,
  updatePatchResourceMock,
  frontResourceEditGuardMock,
  deleteResourceMock,
  getPatchResourceMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  resourceFindFirstMock: vi.fn(),
  acquireKvLockMock: vi.fn(),
  releaseKvLockMock: vi.fn(),
  createPatchResourceMock: vi.fn(),
  updatePatchResourceMock: vi.fn(),
  frontResourceEditGuardMock: vi.fn(),
  deleteResourceMock: vi.fn(),
  getPatchResourceMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock },
    patch_resource: { findFirst: resourceFindFirstMock }
  }
}))

vi.mock('~/lib/redis', () => ({
  acquireKvLock: acquireKvLockMock,
  releaseKvLock: releaseKvLockMock
}))

// service 层各自有测试且签名正在改动, 这里只钉路由闸门: 断言是否走到 service 与传入的 input,
// 不断言 uid/role 的传法
vi.mock('~/app/api/patch/resource/create', () => ({
  createPatchResource: createPatchResourceMock
}))

vi.mock('~/app/api/patch/resource/update', () => ({
  updatePatchResource: updatePatchResourceMock,
  frontResourceEditGuard: frontResourceEditGuardMock
}))

vi.mock('~/app/api/patch/resource/delete', () => ({
  deleteResource: deleteResourceMock
}))

vi.mock('~/app/api/patch/resource/get', () => ({
  getPatchResource: getPatchResourceMock
}))

import { DELETE, POST, PUT } from '~/app/api/patch/resource/route'

const UID = 7
const LOCK_TOKEN = 'lock-token'
const LOCK_KEY = `lock:patch:resource:create:${UID}`
const RESOURCE_ID = 9

const TOUCHGAL_ERROR = '仅超级管理员可使用 TouchGal 资源盘'
const MOEMOEPOINT_ERROR = '仅限萌萌点大于 20 的用户才可以发布资源'
const PENDING_ERROR =
  '您有至少一个 Galgame 资源在待审核阶段, 请等待审核结束后再发布资源'

const userLink = (overrides: Record<string, unknown> = {}) => ({
  storage: 'user',
  hash: '',
  content: 'https://pan.example.com/s/abc',
  size: '1.5 GB',
  code: '',
  password: '',
  ...overrides
})

const touchgalLink = (overrides: Record<string, unknown> = {}) =>
  userLink({
    storage: 'touchgal',
    content: 'https://touchgal.example.com/f/1',
    ...overrides
  })

const createBody = (overrides: Record<string, unknown> = {}) => ({
  patchId: 42,
  section: 'galgame',
  name: '测试资源',
  note: '',
  links: [userLink()],
  type: ['game'],
  language: ['zh-Hans'],
  platform: ['windows'],
  emulatorType: [],
  modelName: '',
  ...overrides
})

const updateBody = (overrides: Record<string, unknown> = {}) => ({
  ...createBody(),
  resourceId: RESOURCE_ID,
  ...overrides
})

const jsonRequest = (method: 'POST' | 'PUT', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/patch/resource', {
    method,
    body: JSON.stringify(body)
  })

const deleteRequest = (query: string) =>
  new NextRequest(`http://localhost/api/patch/resource?${query}`, {
    method: 'DELETE'
  })

const asPayload = (role: number) => ({ uid: UID, name: 'kun', role })

const asUserRow = (overrides: Record<string, unknown> = {}) => ({
  id: UID,
  role: 2,
  moemoepoint: 100,
  ...overrides
})

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue(asPayload(2))
  userFindUniqueMock.mockResolvedValue(asUserRow())
  resourceFindFirstMock.mockResolvedValue(null)
  acquireKvLockMock.mockResolvedValue(LOCK_TOKEN)
  releaseKvLockMock.mockResolvedValue(true)
  createPatchResourceMock.mockResolvedValue({ id: 1, name: 'created' })
  updatePatchResourceMock.mockResolvedValue({
    id: RESOURCE_ID,
    name: 'updated'
  })
  frontResourceEditGuardMock.mockReturnValue({ statusIn: [0] })
  deleteResourceMock.mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/patch/resource 解析与鉴权', () => {
  it('请求体非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(jsonRequest('POST', createBody({ links: [] })))

    expect(await res.json()).toBe('请至少添加一个资源链接')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(userFindUniqueMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不查用户行', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toBe('用户未登录')
    expect(userFindUniqueMock).not.toHaveBeenCalled()
    expect(createPatchResourceMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/patch/resource TouchGal 资源盘闸门 (按会话 payload.role)', () => {
  it.each([1, 2, 3])(
    'role %i 提交 touchgal 链接被拒, 先于查用户行',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      userFindUniqueMock.mockResolvedValue(asUserRow({ role, moemoepoint: 0 }))
      const res = await POST(
        jsonRequest('POST', createBody({ links: [touchgalLink()] }))
      )

      expect(await res.json()).toBe(TOUCHGAL_ERROR)
      expect(userFindUniqueMock).not.toHaveBeenCalled()
      expect(acquireKvLockMock).not.toHaveBeenCalled()
      expect(createPatchResourceMock).not.toHaveBeenCalled()
    }
  )

  it('role 4 提交 touchgal 链接通过闸门', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(4))
    userFindUniqueMock.mockResolvedValue(asUserRow({ role: 4 }))
    const res = await POST(
      jsonRequest('POST', createBody({ links: [touchgalLink()] }))
    )

    expect(await res.json()).toEqual({ id: 1, name: 'created' })
    expect(createPatchResourceMock).toHaveBeenCalledTimes(1)
  })

  it.each([1, 2, 3, 4])('role %i 不含 touchgal 链接时通过', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    userFindUniqueMock.mockResolvedValue(asUserRow({ role }))
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toEqual({ id: 1, name: 'created' })
    expect(createPatchResourceMock).toHaveBeenCalledTimes(1)
  })

  it('整份链接列表里混入一条 touchgal 即拒 (role 3)', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(3))
    const res = await POST(
      jsonRequest('POST', createBody({ links: [userLink(), touchgalLink()] }))
    )

    expect(await res.json()).toBe(TOUCHGAL_ERROR)
  })

  it('会话 role 4、库内 role 1: 按会话放行 touchgal', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(4))
    userFindUniqueMock.mockResolvedValue(asUserRow({ role: 1 }))
    const res = await POST(
      jsonRequest('POST', createBody({ links: [touchgalLink()] }))
    )

    expect(await res.json()).toEqual({ id: 1, name: 'created' })
  })

  it('会话 role 3、库内 role 4: 按会话拒绝 touchgal', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(3))
    userFindUniqueMock.mockResolvedValue(asUserRow({ role: 4 }))
    const res = await POST(
      jsonRequest('POST', createBody({ links: [touchgalLink()] }))
    )

    expect(await res.json()).toBe(TOUCHGAL_ERROR)
    expect(userFindUniqueMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/patch/resource 用户行、萌萌点与待审资源', () => {
  it('用户行不存在返回 未找到该用户, 按会话 uid 查库', async () => {
    userFindUniqueMock.mockResolvedValue(null)
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toBe('未找到该用户')
    expect(userFindUniqueMock).toHaveBeenCalledWith({ where: { id: UID } })
    expect(resourceFindFirstMock).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3, 4])(
    '萌萌点 19 时 role %i 同样被拒 (此处无角色豁免)',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      userFindUniqueMock.mockResolvedValue(asUserRow({ role, moemoepoint: 19 }))
      const res = await POST(jsonRequest('POST', createBody()))

      expect(await res.json()).toBe(MOEMOEPOINT_ERROR)
      expect(resourceFindFirstMock).not.toHaveBeenCalled()
      expect(acquireKvLockMock).not.toHaveBeenCalled()
      expect(createPatchResourceMock).not.toHaveBeenCalled()
    }
  )

  it('role 4 带 touchgal 链接通过资源盘闸门后仍受萌萌点闸门约束', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(4))
    userFindUniqueMock.mockResolvedValue(
      asUserRow({ role: 4, moemoepoint: 19 })
    )
    const res = await POST(
      jsonRequest('POST', createBody({ links: [touchgalLink()] }))
    )

    expect(await res.json()).toBe(MOEMOEPOINT_ERROR)
  })

  it.each([1, 2, 3, 4])('萌萌点 20 时 role %i 通过', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    userFindUniqueMock.mockResolvedValue(asUserRow({ role, moemoepoint: 20 }))
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toEqual({ id: 1, name: 'created' })
  })

  it.each([1, 2, 3, 4])(
    '有待审资源时 role %i 同样被拒 (无角色豁免), 不加锁',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      userFindUniqueMock.mockResolvedValue(asUserRow({ role }))
      resourceFindFirstMock.mockResolvedValue({ id: 3 })
      const res = await POST(jsonRequest('POST', createBody()))

      expect(await res.json()).toBe(PENDING_ERROR)
      expect(resourceFindFirstMock).toHaveBeenCalledWith({
        where: { user_id: UID, status: 2 }
      })
      expect(acquireKvLockMock).not.toHaveBeenCalled()
      expect(createPatchResourceMock).not.toHaveBeenCalled()
    }
  )
})

describe('POST /api/patch/resource 提交锁', () => {
  it('取锁抛错返回服务暂不可用, 不创建也不释放', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    acquireKvLockMock.mockRejectedValue(new Error('redis down'))
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toBe('资源提交服务暂时不可用, 请稍后重试')
    expect(createPatchResourceMock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).not.toHaveBeenCalled()
  })

  it('锁已被占用返回请勿重复点击, 不创建也不释放', async () => {
    acquireKvLockMock.mockResolvedValue(null)
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toBe('资源正在提交中, 请勿重复点击')
    expect(createPatchResourceMock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).not.toHaveBeenCalled()
  })

  it('成功时按用户加 300 秒锁, 把解析后的 input 交给 service 并释放同一把锁', async () => {
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toEqual({ id: 1, name: 'created' })
    expect(acquireKvLockMock).toHaveBeenCalledWith(LOCK_KEY, 300)
    expect(createPatchResourceMock).toHaveBeenCalledTimes(1)
    expect(createPatchResourceMock.mock.calls[0][0]).toEqual(createBody())
    expect(releaseKvLockMock).toHaveBeenCalledWith(LOCK_KEY, LOCK_TOKEN)
  })

  it('service 返回错误串时原样返回并释放锁', async () => {
    createPatchResourceMock.mockResolvedValue('Galgame 不存在')
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toBe('Galgame 不存在')
    expect(releaseKvLockMock).toHaveBeenCalledWith(LOCK_KEY, LOCK_TOKEN)
  })

  it('service 抛错时异常向上冒泡, 但锁仍被释放', async () => {
    createPatchResourceMock.mockRejectedValue(new Error('boom'))

    await expect(POST(jsonRequest('POST', createBody()))).rejects.toThrow(
      'boom'
    )
    expect(releaseKvLockMock).toHaveBeenCalledWith(LOCK_KEY, LOCK_TOKEN)
  })

  it('释放锁失败只记日志, 不影响已有响应', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
    releaseKvLockMock.mockRejectedValue(new Error('redis down'))
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toEqual({ id: 1, name: 'created' })
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })
})

describe('PUT /api/patch/resource 闸门', () => {
  it('请求体非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await PUT(jsonRequest('PUT', updateBody({ links: [] })))

    expect(await res.json()).toBe('请至少添加一个资源链接')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(updatePatchResourceMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不调 service', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await PUT(jsonRequest('PUT', updateBody()))

    expect(await res.json()).toBe('用户未登录')
    expect(updatePatchResourceMock).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3])('role %i 提交 touchgal 链接被拒', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await PUT(
      jsonRequest('PUT', updateBody({ links: [touchgalLink({ id: 5 })] }))
    )

    expect(await res.json()).toBe(TOUCHGAL_ERROR)
    expect(updatePatchResourceMock).not.toHaveBeenCalled()
  })

  it('role 4 提交 touchgal 链接通过', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(4))
    const res = await PUT(
      jsonRequest('PUT', updateBody({ links: [touchgalLink({ id: 5 })] }))
    )

    expect(await res.json()).toEqual({ id: RESOURCE_ID, name: 'updated' })
    expect(updatePatchResourceMock).toHaveBeenCalledTimes(1)
  })

  it.each([1, 2, 3, 4])(
    'role %i 不含 touchgal 链接时直接交给 service (路由不再有其他角色闸门)',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      const res = await PUT(jsonRequest('PUT', updateBody()))

      expect(await res.json()).toEqual({ id: RESOURCE_ID, name: 'updated' })
      expect(updatePatchResourceMock).toHaveBeenCalledTimes(1)
      expect(updatePatchResourceMock.mock.calls[0][0]).toEqual(updateBody())
    }
  )

  it('闸门判整份链接列表: role 3 只改别的链接、touchgal 链接原样保留 (带 id) 也被拒', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(3))
    const res = await PUT(
      jsonRequest(
        'PUT',
        updateBody({
          links: [
            userLink({ id: 4, content: 'https://pan.example.com/s/edited' }),
            touchgalLink({ id: 5 })
          ]
        })
      )
    )

    expect(await res.json()).toBe(TOUCHGAL_ERROR)
    expect(updatePatchResourceMock).not.toHaveBeenCalled()
  })

  it('PUT 不查用户行、不看萌萌点与待审资源、不加锁', async () => {
    userFindUniqueMock.mockResolvedValue(asUserRow({ moemoepoint: 0 }))
    resourceFindFirstMock.mockResolvedValue({ id: 3 })
    const res = await PUT(jsonRequest('PUT', updateBody()))

    expect(await res.json()).toEqual({ id: RESOURCE_ID, name: 'updated' })
    expect(userFindUniqueMock).not.toHaveBeenCalled()
    expect(resourceFindFirstMock).not.toHaveBeenCalled()
    expect(acquireKvLockMock).not.toHaveBeenCalled()
  })

  it('service 返回错误串时原样返回', async () => {
    updatePatchResourceMock.mockResolvedValue('未找到该资源')
    const res = await PUT(jsonRequest('PUT', updateBody()))

    expect(await res.json()).toBe('未找到该资源')
  })
})

describe('DELETE /api/patch/resource 闸门', () => {
  it('resourceId 非数字时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await DELETE(deleteRequest('resourceId=abc'))

    expect(await res.json()).toBe('资源 ID 必须为数字')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(deleteResourceMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不调 service', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await DELETE(deleteRequest(`resourceId=${RESOURCE_ID}`))

    expect(await res.json()).toBe('用户未登录')
    expect(deleteResourceMock).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3, 4])(
    'role %i 直接交给 service (路由层无角色闸门)',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      const res = await DELETE(deleteRequest(`resourceId=${RESOURCE_ID}`))

      expect(await res.json()).toEqual({})
      expect(deleteResourceMock).toHaveBeenCalledTimes(1)
      expect(deleteResourceMock.mock.calls[0][0]).toEqual({
        resourceId: RESOURCE_ID
      })
    }
  )

  it('service 返回错误串时原样返回', async () => {
    deleteResourceMock.mockResolvedValue('您没有权限删除该资源')
    const res = await DELETE(deleteRequest(`resourceId=${RESOURCE_ID}`))

    expect(await res.json()).toBe('您没有权限删除该资源')
  })
})
