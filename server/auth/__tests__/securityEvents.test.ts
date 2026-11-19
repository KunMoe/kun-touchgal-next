import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  updateManyMock,
  deleteKunTokenMock,
  deleteOthersMock,
  reissueMock,
  invalidateMock,
  cookieDeleteMock
} = vi.hoisted(() => ({
  updateManyMock: vi.fn(),
  deleteKunTokenMock: vi.fn(),
  deleteOthersMock: vi.fn(),
  reissueMock: vi.fn(),
  invalidateMock: vi.fn(),
  cookieDeleteMock: vi.fn()
}))

vi.mock('~/server/auth/session', () => ({
  deleteKunToken: deleteKunTokenMock,
  deleteOtherKunTokenSessions: deleteOthersMock,
  reissueKunSessionToken: reissueMock
}))
vi.mock('~/server/auth/sessionCache', () => ({
  invalidateUserSession: invalidateMock
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ delete: cookieDeleteMock })
}))

import {
  applyKunCredentialChange,
  finishKunSecurityEvent,
  KUN_SECURITY_POLICY
} from '~/server/auth/securityEvents'
import type { KunGalgamePayload } from '~/server/auth/session'

const NOW = new Date('2027-01-15T08:00:00.000Z')
// applyKunCredentialChange 只用到 user.updateMany
const db = { user: { updateMany: updateManyMock } } as unknown as Parameters<
  typeof applyKunCredentialChange
>[0]
const current: KunGalgamePayload = {
  iss: 'i',
  aud: 'a',
  jti: 'current-jti',
  uid: 7,
  name: 'kun',
  role: 1,
  auth_time: 100,
  exp: 9999999999
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  updateManyMock.mockResolvedValue({ count: 1 })
  deleteOthersMock.mockResolvedValue(2)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('KUN_SECURITY_POLICY', () => {
  // 改这张表就是改「哪个账号事件吊销什么」: 让这里变红, 逼着改的人看见
  it('每个事件的策略', () => {
    expect(KUN_SECURITY_POLICY).toEqual({
      'password-changed': { bumpStamp: true, current: 'revoke', redis: 'all' },
      'password-reset': { bumpStamp: true, current: 'none', redis: 'all' },
      'password-rehashed': { bumpStamp: false, current: 'none', redis: 'none' },
      'email-changed': { bumpStamp: true, current: 'keep', redis: 'others' },
      'email-reverted': { bumpStamp: true, current: 'none', redis: 'all' },
      '2fa-secret-staged': { bumpStamp: false, current: 'none', redis: 'none' },
      '2fa-enabled': { bumpStamp: true, current: 'keep', redis: 'others' },
      '2fa-disabled': { bumpStamp: true, current: 'keep', redis: 'others' },
      '2fa-disabled-by-admin': {
        bumpStamp: false,
        current: 'none',
        redis: 'all'
      },
      'admin-edited': { bumpStamp: false, current: 'none', redis: 'all' },
      'admin-credentials-changed': {
        bumpStamp: true,
        current: 'none',
        redis: 'all'
      },
      'creator-approved': { bumpStamp: false, current: 'none', redis: 'none' },
      'username-reserved-migrated': {
        bumpStamp: false,
        current: 'none',
        redis: 'all'
      },
      'other-sessions-revoked': {
        bumpStamp: true,
        current: 'keep',
        redis: 'others'
      },
      'account-deletion-started': {
        bumpStamp: false,
        current: 'none',
        redis: 'all'
      },
      'account-deleted': { bumpStamp: false, current: 'none', redis: 'all' },
      'ban-detected': { bumpStamp: false, current: 'none', redis: 'all' }
    })
  })
})

describe('applyKunCredentialChange', () => {
  it('刷新戳的事件: 戳与凭据写在同一个 data 里, 前置条件留在平铺 WHERE 里', async () => {
    const result = await applyKunCredentialChange(db, {
      uid: 7,
      event: 'password-changed',
      where: { password: 'old-hash' },
      data: { password: 'new-hash' }
    })

    expect(updateManyMock).toHaveBeenCalledTimes(1)
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { password: 'old-hash', id: 7 },
      data: { password: 'new-hash', security_stamp: NOW }
    })
    expect(result).toEqual({ count: 1, stamp: NOW })
  })

  it('不刷新戳的事件: data 原样写入', async () => {
    const result = await applyKunCredentialChange(db, {
      uid: 7,
      event: 'password-rehashed',
      data: { password: 'new-hash' }
    })

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { password: 'new-hash' }
    })
    expect(result).toEqual({ count: 1, stamp: null })
  })

  it('调用方的 where 不能把 id 换掉', async () => {
    await applyKunCredentialChange(db, {
      uid: 7,
      event: 'admin-edited',
      where: { id: 8 } as never,
      data: { status: 2 }
    })

    expect(updateManyMock.mock.calls[0][0].where.id).toBe(7)
  })

  it.each([
    ['令牌不带戳 (0) 时要求库里也是 null', 0, null],
    [
      '令牌带戳时要求库里是同一个值',
      NOW.getTime() - 5000,
      new Date(NOW.getTime() - 5000)
    ]
  ])(
    '保留并重签当前会话的事件以当前令牌的戳为条件: %s',
    async (_label, currentStamp, expected) => {
      await applyKunCredentialChange(db, {
        uid: 7,
        event: 'other-sessions-revoked',
        data: {},
        currentStamp
      })

      expect(updateManyMock).toHaveBeenCalledWith({
        where: { security_stamp: expected, id: 7 },
        data: { security_stamp: NOW }
      })
    }
  )

  it('保留并重签当前会话的事件不传当前令牌的戳就抛错', async () => {
    await expect(
      applyKunCredentialChange(db, {
        uid: 7,
        event: 'email-changed',
        data: { email: 'b' }
      })
    ).rejects.toThrow()
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it('命中 0 行 (前置条件落空): 没有写下戳', async () => {
    updateManyMock.mockResolvedValue({ count: 0 })

    expect(
      await applyKunCredentialChange(db, {
        uid: 7,
        event: 'password-reset',
        data: { password: 'h' }
      })
    ).toEqual({ count: 0, stamp: null })
  })
})

describe('finishKunSecurityEvent', () => {
  it('删光会话: 失效缓存、删全部会话键, 不碰当前会话', async () => {
    await finishKunSecurityEvent(7, 'password-reset')

    expect(invalidateMock).toHaveBeenCalledWith(7)
    expect(deleteKunTokenMock).toHaveBeenCalledWith(7)
    expect(deleteOthersMock).not.toHaveBeenCalled()
    expect(cookieDeleteMock).not.toHaveBeenCalled()
    expect(reissueMock).not.toHaveBeenCalled()
  })

  it('current: revoke 清掉当前会话的 cookie', async () => {
    await finishKunSecurityEvent(7, 'password-changed', { current, stamp: NOW })

    expect(deleteKunTokenMock).toHaveBeenCalledWith(7)
    expect(cookieDeleteMock).toHaveBeenCalledWith('kun-galgame-patch-moe-token')
    expect(reissueMock).not.toHaveBeenCalled()
  })

  it('redis: others + current: keep: 删掉其它会话, 当前会话带着新戳重签, 返回删掉了几个', async () => {
    const result = await finishKunSecurityEvent(7, 'other-sessions-revoked', {
      current,
      stamp: NOW
    })

    expect(deleteOthersMock).toHaveBeenCalledWith(7, 'current-jti')
    expect(deleteKunTokenMock).not.toHaveBeenCalled()
    expect(cookieDeleteMock).not.toHaveBeenCalled()
    expect(reissueMock).toHaveBeenCalledWith(current, NOW)
    expect(result).toEqual({ revokedOthers: 2 })
    // 先失效鉴权缓存 (里面还是旧戳) 再重签
    expect(invalidateMock.mock.invocationCallOrder[0]).toBeLessThan(
      reissueMock.mock.invocationCallOrder[0]
    )
  })

  it.each(['email-changed', '2fa-enabled', '2fa-disabled'] as const)(
    '%s: 其它设备登出, 当前会话重签',
    async (event) => {
      await finishKunSecurityEvent(7, event, { current, stamp: NOW })

      expect(deleteOthersMock).toHaveBeenCalledWith(7, 'current-jti')
      expect(reissueMock).toHaveBeenCalledWith(current, NOW)
      expect(deleteKunTokenMock).not.toHaveBeenCalled()
    }
  )

  it('刷新了戳却没传新戳: 抛错, 不留一个带旧戳的当前会话', async () => {
    await expect(
      finishKunSecurityEvent(7, 'email-changed', { current, stamp: null })
    ).rejects.toThrow()
    expect(reissueMock).not.toHaveBeenCalled()
  })

  it('撤销邮箱变更: 删光会话, 没有当前会话要处理', async () => {
    await finishKunSecurityEvent(7, 'email-reverted')

    expect(deleteKunTokenMock).toHaveBeenCalledWith(7)
    expect(reissueMock).not.toHaveBeenCalled()
  })

  it('只失效缓存的事件不删任何会话键', async () => {
    await finishKunSecurityEvent(7, 'creator-approved')

    expect(invalidateMock).toHaveBeenCalledWith(7)
    expect(deleteKunTokenMock).not.toHaveBeenCalled()
    expect(deleteOthersMock).not.toHaveBeenCalled()
  })

  it('需要当前会话的事件不传就抛错 (写错了, 不是悄悄删光)', async () => {
    await expect(
      finishKunSecurityEvent(7, 'other-sessions-revoked')
    ).rejects.toThrow()
    await expect(
      finishKunSecurityEvent(7, 'password-changed')
    ).rejects.toThrow()
    expect(deleteKunTokenMock).not.toHaveBeenCalled()
    expect(deleteOthersMock).not.toHaveBeenCalled()
  })

  it('删键失败照常往外抛: 影子模式下删键仍是唯一生效的吊销', async () => {
    deleteKunTokenMock.mockRejectedValue(new Error('redis down'))

    await expect(finishKunSecurityEvent(7, 'password-reset')).rejects.toThrow(
      'redis down'
    )
  })
})
