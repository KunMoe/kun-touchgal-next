import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reservedUsernameMessage } from '~/constants/reserved-usernames.server'
import { emailShapedUsernameMessage } from '~/server/identity/username'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  findUserMock,
  findFirstMock,
  transactionMock,
  updateUserMock,
  createLogMock,
  finishMock,
  hashPasswordMock
} = vi.hoisted(() => ({
  findUserMock: vi.fn(),
  findFirstMock: vi.fn(),
  transactionMock: vi.fn(),
  updateUserMock: vi.fn(),
  createLogMock: vi.fn(),
  finishMock: vi.fn(),
  hashPasswordMock: vi.fn()
}))

// 凭据与权限列经 applyKunCredentialChange 写入 (平铺 WHERE 的 updateMany)
const transactionClient = {
  user: { updateMany: updateUserMock },
  admin_log: { create: createLogMock }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    // findFirst 是 server/identity/lookup.ts 的查重 (大小写不敏感, 排除目标用户自己)
    user: { findUnique: findUserMock, findFirst: findFirstMock },
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
import { adminUpdateUserSchema } from '~/validations/admin'

// 库里存量的保留名用户: uid 1 (超管本人) 与冒名的 admin 都属于这一类
const reservedNameUser = {
  id: 7,
  daily_image_count: 10,
  moemoepoint: 100,
  name: 'admin',
  email: 'target@example.com',
  bio: '',
  role: 1,
  status: 0
}

const baseInput = {
  uid: 7,
  name: 'admin',
  email: 'target@example.com',
  role: 1,
  status: 0,
  dailyImageCount: 10,
  moemoepoint: 100,
  bio: ''
}

beforeEach(() => {
  vi.clearAllMocks()
  findUserMock
    .mockResolvedValueOnce(reservedNameUser)
    .mockResolvedValueOnce({ role: 4, name: 'root-admin' })
  findFirstMock.mockReset()
  findFirstMock.mockResolvedValue(null)
  updateUserMock.mockResolvedValue({ count: 1 })
  createLogMock.mockResolvedValue({})
  finishMock.mockResolvedValue({ revokedOthers: 0 })
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('updateUser 保留用户名', () => {
  it('不改名时放行存量保留名用户的封禁与改权', async () => {
    await expect(
      updateUser({ ...baseInput, role: 2, status: 1 }, 99)
    ).resolves.toEqual({})

    // 只查目标用户与管理员两次, 不进重名查询分支
    expect(findUserMock).toHaveBeenCalledTimes(2)
    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        daily_image_count: 10,
        name: 'admin',
        email: 'target@example.com',
        role: 2,
        status: 1,
        moemoepoint: 100,
        bio: ''
      }
    })
    expect(finishMock).toHaveBeenCalledWith(7, 'admin-edited')
  })

  it('拒绝把用户改名为保留词, 不落库', async () => {
    findUserMock.mockReset()
    findUserMock
      .mockResolvedValueOnce({ ...reservedNameUser, name: 'kun' })
      .mockResolvedValueOnce({ role: 4, name: 'root-admin' })

    await expect(
      updateUser({ ...baseInput, name: 'Official' }, 99)
    ).resolves.toBe(reservedUsernameMessage)

    // 保留词在重名查询之前拦下, 不多打一次库
    expect(findUserMock).toHaveBeenCalledTimes(2)
    expect(transactionMock).not.toHaveBeenCalled()
    expect(finishMock).not.toHaveBeenCalled()
  })

  it('允许把存量保留名用户改成非保留名', async () => {
    await expect(
      updateUser({ ...baseInput, name: 'kun-admin' }, 99)
    ).resolves.toEqual({})

    expect(findFirstMock).toHaveBeenCalledWith({
      where: {
        name: { equals: 'kun-admin', mode: 'insensitive' },
        id: { not: 7 }
      },
      select: { id: true }
    })
    expect(updateUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'kun-admin' })
      })
    )
  })
})

describe('updateUser 新名字的规则与查重 (T18)', () => {
  const setupTarget = (name: string) => {
    findUserMock.mockReset()
    findUserMock
      .mockResolvedValueOnce({ ...reservedNameUser, name })
      .mockResolvedValueOnce({ role: 4, name: 'root-admin' })
  }

  it('拒绝改成邮箱形态的名字, 不查重也不落库', async () => {
    setupTarget('kun')

    await expect(
      updateUser({ ...baseInput, name: 'victim@qq.com' }, 99)
    ).resolves.toBe(emailShapedUsernameMessage)

    expect(findFirstMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  // 存量里改名规则收紧之前取的邮箱形态名: 整表单提交时 name 恒定携带, 不改名就不判
  it('不改名时放行存量的邮箱形态名', async () => {
    setupTarget('legacy@qq.com')

    await expect(
      updateUser({ ...baseInput, name: 'legacy@qq.com', status: 1 }, 99)
    ).resolves.toEqual({})

    expect(findFirstMock).not.toHaveBeenCalled()
  })

  it('别人已有只差大小写的名字时拒绝', async () => {
    setupTarget('kun')
    findFirstMock.mockResolvedValue({ id: 9 })

    await expect(updateUser({ ...baseInput, name: 'Taken' }, 99)).resolves.toBe(
      '该用户名已被其他用户使用'
    )

    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('别人已有只差大小写的邮箱时拒绝', async () => {
    findFirstMock.mockResolvedValue({ id: 9 })

    await expect(
      updateUser({ ...baseInput, email: 'TAKEN@example.com' }, 99)
    ).resolves.toBe('该邮箱已被其他用户使用')

    expect(transactionMock).not.toHaveBeenCalled()
  })

  // 查重与写入之间被别人取走 (含只差大小写, 撞 lower() 唯一索引)
  it('写入撞唯一约束时回业务错误, 不写审计日志', async () => {
    setupTarget('kun')
    transactionMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test'
      })
    )

    await expect(updateUser({ ...baseInput, name: 'Fresh' }, 99)).resolves.toBe(
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
    hashPasswordMock.mockResolvedValue('new-hash')

    await expect(updateUser({ ...baseInput, ...change }, 99)).resolves.toEqual(
      {}
    )

    // 新邮箱的查重: 大小写不敏感, 排除目标用户自己; 没改邮箱就不查
    expect(findFirstMock).toHaveBeenCalledTimes(checksEmail ? 1 : 0)
    if (checksEmail) {
      expect(findFirstMock).toHaveBeenCalledWith({
        where: {
          email: { equals: 'recovered@example.com', mode: 'insensitive' },
          id: { not: 7 }
        },
        select: { id: true }
      })
    }

    expect(updateUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ security_stamp: expect.any(Date) })
      })
    )
    expect(finishMock).toHaveBeenCalledWith(7, 'admin-credentials-changed')
  })

  it('只改资料与权限: 不刷新戳', async () => {
    await updateUser({ ...baseInput, role: 2 }, 99)

    expect(updateUserMock.mock.calls[0][0].data).not.toHaveProperty(
      'security_stamp'
    )
    expect(finishMock).toHaveBeenCalledWith(7, 'admin-edited')
  })
})

describe('updateUser 角色按 delta 判定', () => {
  const setup = (targetRole: number, operatorRole = 4) => {
    findUserMock.mockReset()
    findUserMock
      .mockResolvedValueOnce({ ...reservedNameUser, role: targetRole })
      .mockResolvedValueOnce({ role: operatorRole, name: 'root-admin' })
  }

  it('没改角色时可以保存超级管理员账号的其它字段', async () => {
    setup(4)

    await expect(
      updateUser({ ...baseInput, role: 4, moemoepoint: 7 }, 99)
    ).resolves.toEqual({})

    expect(updateUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 4, moemoepoint: 7 })
      })
    )
  })

  it.each([1, 2, 3])(
    '不能把 role %i 的用户设置为超级管理员, 不落库',
    async (targetRole) => {
      setup(targetRole)

      await expect(updateUser({ ...baseInput, role: 4 }, 99)).resolves.toBe(
        '不能将用户设置为该角色'
      )

      expect(transactionMock).not.toHaveBeenCalled()
      expect(finishMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    [1, 3],
    [3, 1],
    [4, 3],
    [4, 1]
  ])('可以把 role %i 改成 role %i (含给超级管理员降权)', async (from, to) => {
    setup(from)

    await expect(updateUser({ ...baseInput, role: to }, 99)).resolves.toEqual(
      {}
    )

    expect(updateUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: to }) })
    )
    expect(finishMock).toHaveBeenCalledWith(7, 'admin-edited')
  })

  it('操作者在库里已不是超级管理员时不能改任何人的角色', async () => {
    setup(1, 3)

    await expect(updateUser({ ...baseInput, role: 2 }, 99)).resolves.toBe(
      '设置用户为管理员仅限超级管理员可用'
    )

    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('schema 只校验角色的取值域, 不在这一层卡可授予的上限', () => {
    const parse = (role: number) =>
      adminUpdateUserSchema.safeParse({ ...baseInput, role }).success

    expect([1, 2, 3, 4].map(parse)).toEqual([true, true, true, true])
    expect([0, 5].map(parse)).toEqual([false, false])
  })
})
