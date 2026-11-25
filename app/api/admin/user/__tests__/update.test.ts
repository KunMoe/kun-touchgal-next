import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reservedUsernameMessage } from '~/constants/reserved-usernames.server'
import { emailShapedUsernameMessage } from '~/server/identity/username'
import { Prisma } from '~/prisma/generated/prisma/client'
import { parseLowerLookup } from '~/server/identity/__tests__/support/lowerLookup'
import { kunZodErrorMap } from '~/validations/errorMap'

const {
  findUserMock,
  queryRawMock,
  transactionMock,
  updateUserMock,
  adjustUserMock,
  readSavedMock,
  createLogMock,
  finishMock,
  hashPasswordMock
} = vi.hoisted(() => ({
  findUserMock: vi.fn(),
  queryRawMock: vi.fn(),
  transactionMock: vi.fn(),
  updateUserMock: vi.fn(),
  adjustUserMock: vi.fn(),
  readSavedMock: vi.fn(),
  createLogMock: vi.fn(),
  finishMock: vi.fn(),
  hashPasswordMock: vi.fn()
}))

// 凭据与权限列经 applyKunCredentialChange 写入 (平铺 WHERE 的 updateMany); 萌萌点经
// server/points 的 adjustPoints 按差值写 (update); 写完在同一事务里读回写后的行
const transactionClient = {
  user: {
    updateMany: updateUserMock,
    update: adjustUserMock,
    findUniqueOrThrow: readSavedMock
  },
  admin_log: { create: createLogMock }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    // $queryRaw 是 server/identity/lookup.ts 按 lower() 的查重 (排除目标用户自己)
    $queryRaw: queryRawMock,
    user: { findUnique: findUserMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/server/auth/securityEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/auth/securityEvents')>()),
  finishKunSecurityEvent: finishMock
}))

vi.mock('~/app/api/utils/algorithm', () => ({
  hashPassword: hashPasswordMock
}))

import { updateUser } from '~/app/api/admin/user/update'
import { adminPatchUserSchema } from '~/validations/admin'

// 库里存量的保留名用户: uid 1 (超管本人) 与冒名的 admin 都属于这一类
const target = {
  id: 7,
  daily_image_count: 10,
  moemoepoint: 100,
  name: 'admin',
  email: 'target@example.com',
  bio: '',
  role: 1,
  status: 0
}

// 写后读回的行 (库里的真值, 可能含别处并发写下的值)
const savedRow = {
  id: 7,
  name: 'admin',
  email: 'target@example.com',
  bio: 'hi',
  role: 2,
  status: 0,
  daily_image_count: 10,
  moemoepoint: 105
}
const savedResult = {
  id: 7,
  name: 'admin',
  email: 'target@example.com',
  bio: 'hi',
  role: 2,
  status: 0,
  dailyImageCount: 10,
  moemoepoint: 105
}

const setupTarget = (overrides: Partial<typeof target> = {}, adminRole = 4) => {
  findUserMock.mockReset()
  findUserMock
    .mockResolvedValueOnce({ ...target, ...overrides })
    .mockResolvedValueOnce({ role: adminRole, name: 'root-admin' })
}

// 没写进库: 没开事务, 也没吊销会话
const expectNothingWritten = () => {
  expect(transactionMock).not.toHaveBeenCalled()
  expect(updateUserMock).not.toHaveBeenCalled()
  expect(adjustUserMock).not.toHaveBeenCalled()
  expect(finishMock).not.toHaveBeenCalled()
}

const parse = (input: unknown) =>
  adminPatchUserSchema.safeParse(input, { error: kunZodErrorMap })

const messagesOf = (input: unknown) =>
  parse(input).error?.issues.map((issue) => issue.message)

beforeEach(() => {
  vi.resetAllMocks()
  setupTarget()
  queryRawMock.mockResolvedValue([])
  updateUserMock.mockResolvedValue({ count: 1 })
  adjustUserMock.mockResolvedValue({ moemoepoint: 0 })
  readSavedMock.mockResolvedValue(savedRow)
  createLogMock.mockResolvedValue({})
  finishMock.mockResolvedValue({ revokedOthers: 0 })
  hashPasswordMock.mockResolvedValue('new-hash')
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

// 表单曾整行提交、按打开时的快照绝对值写回: 期间别处写下的改名、改邮箱、升权、封禁、
// 萌萌点与图片计数被静默回滚 (P06-02 / X03-01 / X04-04), 只属于某一列的上限又锁死整次
// 保存 (计数 51、role 4、负余额)。现在请求只带改了的键
describe('adminPatchUserSchema 合并契约', () => {
  it('拒绝旧页面的整行请求体, 不剥掉未知键后接着覆盖', () => {
    const legacyBody = {
      uid: 7,
      name: 'admin',
      email: 'target@example.com',
      role: 1,
      status: 0,
      dailyImageCount: 10,
      bio: ''
    }

    expect(messagesOf(legacyBody)).toEqual(['页面版本已过期, 请刷新后重试'])
    expect(messagesOf({ uid: 7, moemoepoint: 200 })).toEqual([
      '页面版本已过期, 请刷新后重试'
    ])
  })

  it('没有任何修改时拒绝 (空白密码不算修改)', () => {
    expect(messagesOf({ uid: 7 })).toEqual(['没有需要保存的修改'])
    expect(messagesOf({ uid: 7, password: '   ' })).toEqual([
      '没有需要保存的修改'
    ])
  })

  it('只带一项修改即可通过, 没带的键不出现在结果里', () => {
    expect(parse({ uid: 7, status: 2 }).data).toEqual({ uid: 7, status: 2 })
    expect(parse({ uid: 7, bio: 'hi' }).data).toEqual({ uid: 7, bio: 'hi' })
  })

  it('萌萌点只收非零整数差值, 不设下限', () => {
    expect(parse({ uid: 7, moemoepointDelta: -12 }).data).toEqual({
      uid: 7,
      moemoepointDelta: -12
    })
    expect(messagesOf({ uid: 7, moemoepointDelta: 0 })).toEqual([
      '萌萌点调整值不能为 0'
    ])
    expect(parse({ uid: 7, moemoepointDelta: 1.5 }).success).toBe(false)
    expect(parse({ uid: 7, moemoepointDelta: 10000000 }).success).toBe(false)
  })

  it('图片计数只能清零', () => {
    expect(parse({ uid: 7, resetDailyImageCount: true }).success).toBe(true)
    expect(messagesOf({ uid: 7, resetDailyImageCount: false })).toEqual([
      '清零图片计数的参数无效'
    ])
  })

  it('角色只校验取值域, 不在这一层卡可授予的上限', () => {
    const parsesRole = (role: number) => parse({ uid: 7, role }).success

    expect([1, 2, 3, 4].map(parsesRole)).toEqual([true, true, true, true])
    expect([0, 5].map(parsesRole)).toEqual([false, false])
  })
})

describe('updateUser 只写请求里带的列', () => {
  it('只改签名: 写入体只有签名, 返回写后读回的行', async () => {
    await expect(updateUser({ uid: 7, bio: 'hi' }, 99)).resolves.toEqual(
      savedResult
    )

    expect(updateUserMock.mock.calls).toEqual([
      [{ where: { id: 7 }, data: { bio: 'hi' } }]
    ])
    expect(adjustUserMock).not.toHaveBeenCalled()
    expect(readSavedMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } })
    )
    // 日志的「更改内容」就是这次的差异
    expect(createLogMock.mock.calls[0][0].data.content).toContain(
      '更改内容:\n{"uid":7,"bio":"hi"}'
    )
    expect(finishMock).toHaveBeenCalledWith(7, 'admin-edited')
  })

  it('只带状态即可封禁负余额、计数超过上限的存量保留名用户', async () => {
    setupTarget({ moemoepoint: -5, daily_image_count: 51 })

    await expect(updateUser({ uid: 7, status: 2 }, 99)).resolves.toEqual(
      savedResult
    )

    // 没带名字: 不进改名规则与查重
    expect(queryRawMock).not.toHaveBeenCalled()
    expect(updateUserMock.mock.calls).toEqual([
      [{ where: { id: 7 }, data: { status: 2 } }]
    ])
    expect(finishMock).toHaveBeenCalledWith(7, 'admin-edited')
  })

  it('清零图片计数: 写 0', async () => {
    await updateUser({ uid: 7, resetDailyImageCount: true }, 99)

    expect(updateUserMock.mock.calls).toEqual([
      [{ where: { id: 7 }, data: { daily_image_count: 0 } }]
    ])
  })

  it('用户在查询之后被删了: 整笔回滚, 不吊销会话', async () => {
    updateUserMock.mockResolvedValue({ count: 0 })

    await expect(updateUser({ uid: 7, bio: 'hi' }, 99)).rejects.toThrow(
      '用户 7 已不存在'
    )

    expect(finishMock).not.toHaveBeenCalled()
  })
})

describe('updateUser 保留用户名', () => {
  it('名字与原名相同 (只差前后空白, 已被 trim) 时不判保留词', async () => {
    await expect(
      updateUser({ uid: 7, name: 'admin', status: 2 }, 99)
    ).resolves.toEqual(savedResult)

    expect(queryRawMock).not.toHaveBeenCalled()
  })

  it('拒绝把用户改名为保留词, 不落库', async () => {
    setupTarget({ name: 'kun' })

    await expect(updateUser({ uid: 7, name: 'Official' }, 99)).resolves.toBe(
      reservedUsernameMessage
    )

    // 保留词在重名查询之前拦下, 不多打一次库
    expect(queryRawMock).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('允许把存量保留名用户改成非保留名', async () => {
    await expect(
      updateUser({ uid: 7, name: 'kun-admin' }, 99)
    ).resolves.toEqual(savedResult)

    expect(
      queryRawMock.mock.calls.map(([query]) => parseLowerLookup(query))
    ).toEqual([{ column: 'name', value: 'kun-admin', exceptUid: 7 }])
    expect(updateUserMock.mock.calls).toEqual([
      [{ where: { id: 7 }, data: { name: 'kun-admin' } }]
    ])
  })
})

describe('updateUser 新名字的规则与查重 (T18)', () => {
  it('拒绝改成邮箱形态的名字, 不查重也不落库', async () => {
    setupTarget({ name: 'kun' })

    await expect(
      updateUser({ uid: 7, name: 'victim@qq.com' }, 99)
    ).resolves.toBe(emailShapedUsernameMessage)

    expect(queryRawMock).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('不改名时放行存量的邮箱形态名', async () => {
    setupTarget({ name: 'legacy@qq.com' })

    await expect(
      updateUser({ uid: 7, name: 'legacy@qq.com', status: 2 }, 99)
    ).resolves.toEqual(savedResult)

    expect(queryRawMock).not.toHaveBeenCalled()
  })

  it('别人已有只差大小写的名字时拒绝', async () => {
    setupTarget({ name: 'kun' })
    queryRawMock.mockResolvedValue([{ id: 9 }])

    await expect(updateUser({ uid: 7, name: 'Taken' }, 99)).resolves.toBe(
      '该用户名已被其他用户使用'
    )

    expectNothingWritten()
  })

  it('别人已有只差大小写的邮箱时拒绝', async () => {
    queryRawMock.mockResolvedValue([{ id: 9 }])

    await expect(
      updateUser({ uid: 7, email: 'TAKEN@example.com' }, 99)
    ).resolves.toBe('该邮箱已被其他用户使用')

    expectNothingWritten()
  })

  // 查重与写入之间被别人取走 (含只差大小写, 撞 lower() 唯一索引)
  it('写入撞唯一约束时回业务错误, 不写审计日志', async () => {
    setupTarget({ name: 'kun' })
    transactionMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test'
      })
    )

    await expect(updateUser({ uid: 7, name: 'Fresh' }, 99)).resolves.toBe(
      '该用户名或邮箱已被其他用户使用'
    )

    expect(finishMock).not.toHaveBeenCalled()
  })
})

describe('updateUser 改了密码或邮箱 (账号恢复)', () => {
  it.each([
    ['设了新密码', { password: 'newpass123' }, false],
    ['改了邮箱', { email: 'recovered@example.com' }, true]
  ])('%s: 走刷新安全戳的事件', async (_label, change, checksEmail) => {
    await expect(updateUser({ uid: 7, ...change }, 99)).resolves.toEqual(
      savedResult
    )

    // 新邮箱的查重: 大小写不敏感, 排除目标用户自己; 没带邮箱就不查
    expect(
      queryRawMock.mock.calls.map(([query]) => parseLowerLookup(query))
    ).toEqual(
      checksEmail
        ? [{ column: 'email', value: 'recovered@example.com', exceptUid: 7 }]
        : []
    )

    expect(updateUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ security_stamp: expect.any(Date) })
      })
    )
    // 日志里不留密码哈希
    expect(createLogMock.mock.calls[0][0].data.content).not.toContain(
      'newpass123'
    )
    expect(finishMock).toHaveBeenCalledWith(7, 'admin-credentials-changed')
  })

  it('只改资料与权限: 不刷新戳', async () => {
    await updateUser({ uid: 7, role: 2 }, 99)

    expect(updateUserMock.mock.calls[0][0].data).not.toHaveProperty(
      'security_stamp'
    )
    expect(finishMock).toHaveBeenCalledWith(7, 'admin-edited')
  })
})

// 后台的操作者自己就是超级管理员: 这条规则同时挡住改自己的邮箱密码 (绕过自助入口的
// 二次验证) 与封禁、降权自己
describe('updateUser 超级管理员账号', () => {
  it.each([
    ['邮箱', { email: 'new@example.com' }],
    ['密码', { password: 'newpass123' }],
    ['角色 (降权)', { role: 3 }],
    ['角色 (与当前相同)', { role: 4 }],
    ['状态', { status: 2 }]
  ])('带%s时拒绝, 不落库', async (_label, change) => {
    setupTarget({ role: 4 })

    await expect(
      updateUser({ uid: 7, bio: 'hi', ...change }, 99)
    ).resolves.toBe('不能在后台修改超级管理员的邮箱、密码、角色或状态')

    expect(queryRawMock).not.toHaveBeenCalled()
    expect(hashPasswordMock).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('可以改名字、签名、萌萌点与图片计数', async () => {
    setupTarget({ role: 4, name: 'kun' })

    await expect(
      updateUser(
        {
          uid: 7,
          name: 'kun-root',
          bio: 'hi',
          moemoepointDelta: 5,
          resetDailyImageCount: true
        },
        99
      )
    ).resolves.toEqual(savedResult)

    expect(updateUserMock.mock.calls).toEqual([
      [
        {
          where: { id: 7 },
          data: { name: 'kun-root', bio: 'hi', daily_image_count: 0 }
        }
      ]
    ])
    expect(adjustUserMock).toHaveBeenCalledTimes(1)
    expect(finishMock).toHaveBeenCalledWith(7, 'admin-edited')
  })
})

describe('updateUser 角色按 delta 判定', () => {
  it.each([1, 2, 3])(
    '不能把 role %i 的用户设置为超级管理员, 不落库',
    async (targetRole) => {
      setupTarget({ role: targetRole })

      await expect(updateUser({ uid: 7, role: 4 }, 99)).resolves.toBe(
        '不能将用户设置为该角色'
      )

      expectNothingWritten()
    }
  )

  it.each([
    [1, 3],
    [3, 1],
    [2, 1]
  ])('可以把 role %i 改成 role %i', async (from, to) => {
    setupTarget({ role: from })

    await expect(updateUser({ uid: 7, role: to }, 99)).resolves.toEqual(
      savedResult
    )

    expect(updateUserMock.mock.calls).toEqual([
      [{ where: { id: 7 }, data: { role: to } }]
    ])
    expect(finishMock).toHaveBeenCalledWith(7, 'admin-edited')
  })

  it('操作者在库里已不是超级管理员时不能改任何人的角色', async () => {
    setupTarget({ role: 1 }, 3)

    await expect(updateUser({ uid: 7, role: 2 }, 99)).resolves.toBe(
      '设置用户为管理员仅限超级管理员可用'
    )

    expectNothingWritten()
  })
})

describe('updateUser 萌萌点按差值调整', () => {
  it('只调萌萌点: 不进凭据写入, 按差值写, 记入审计并吊销会话', async () => {
    await expect(
      updateUser({ uid: 7, moemoepointDelta: -30 }, 99)
    ).resolves.toEqual(savedResult)

    expect(updateUserMock).not.toHaveBeenCalled()
    expect(adjustUserMock.mock.calls).toEqual([
      [
        {
          where: { id: 7 },
          data: { moemoepoint: { increment: -30 } },
          select: { moemoepoint: true }
        }
      ]
    ])
    expect(createLogMock.mock.calls[0][0].data.content).toContain(
      '"moemoepointDelta":-30'
    )
    expect(finishMock).toHaveBeenCalledWith(7, 'admin-edited')
  })

  it('与别的列一起改: 萌萌点不进凭据写入体', async () => {
    await updateUser({ uid: 7, bio: 'hi', moemoepointDelta: 10 }, 99)

    expect(updateUserMock.mock.calls).toEqual([
      [{ where: { id: 7 }, data: { bio: 'hi' } }]
    ])
    expect(adjustUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { moemoepoint: { increment: 10 } } })
    )
  })

  it('不带差值时不写萌萌点', async () => {
    await updateUser({ uid: 7, status: 2 }, 99)

    expect(adjustUserMock).not.toHaveBeenCalled()
  })
})
