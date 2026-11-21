import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  delKvMock,
  getKvMock,
  invalidateUserSessionMock,
  userFindUniqueMock,
  userUpdateManyMock,
  userUpdateMock
} = vi.hoisted(() => ({
  delKvMock: vi.fn(),
  getKvMock: vi.fn(),
  invalidateUserSessionMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  userUpdateMock: vi.fn()
}))

vi.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/lib/redis', () => ({
  delKv: delKvMock,
  getKv: getKvMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: {
      findUnique: userFindUniqueMock,
      update: userUpdateMock,
      updateMany: userUpdateManyMock
    }
  }
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

import { POST } from '~/app/api/auth/email-notice/disable/route'
import { signUnsubscribeToken } from '~/server/mail/unsubscribeToken'

const post = async (body: unknown) => {
  const response = await POST(
    new Request('http://localhost/api/auth/email-notice/disable', {
      method: 'POST',
      body: JSON.stringify(body)
    }) as unknown as Parameters<typeof POST>[0]
  )
  return response.json()
}

const INVALID_LINK = '退订链接无效, 请您登录后在用户设置页面取消邮件订阅'
const LEGACY_CODE = '0b5d7b0c-3a51-4d4a-9a3a-0f6f2c5f7f10'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('KUN_EMAIL_UNSUBSCRIBE_SECRET', 'k'.repeat(32))
  userUpdateManyMock.mockResolvedValue({ count: 1 })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/auth/email-notice/disable 凭签名令牌', () => {
  it('令牌对得上就关掉这个用户的邮件通知, 并让他的会话缓存失效', async () => {
    await expect(
      post({ uid: 42, token: signUnsubscribeToken(42) })
    ).resolves.toEqual({})

    expect(userUpdateManyMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: 42 },
      data: { enable_email_notice: false }
    })
    expect(invalidateUserSessionMock).toHaveBeenCalledExactlyOnceWith(42)
  })

  it('落地页从查询串读到的 id 是字符串, 同样认', async () => {
    await expect(
      post({ uid: '42', token: signUnsubscribeToken(42) })
    ).resolves.toEqual({})

    expect(userUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42 } })
    )
  })

  it('同一个链接点几次都成功, 不碰 Redis 里的旧验证码', async () => {
    const body = { uid: 42, token: signUnsubscribeToken(42) }

    await expect(post(body)).resolves.toEqual({})
    await expect(post(body)).resolves.toEqual({})

    expect(userUpdateManyMock).toHaveBeenCalledTimes(2)
    expect(getKvMock).not.toHaveBeenCalled()
    expect(delKvMock).not.toHaveBeenCalled()
  })

  it('账号已经不存在时仍按成功处理, 不为它写会话缓存', async () => {
    userUpdateManyMock.mockResolvedValue({ count: 0 })

    await expect(
      post({ uid: 42, token: signUnsubscribeToken(42) })
    ).resolves.toEqual({})

    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })

  it.each([
    ['别的用户的令牌', () => ({ uid: 42, token: signUnsubscribeToken(43) })],
    ['瞎编的令牌', () => ({ uid: 42, token: 'A'.repeat(32) })]
  ])('%s被拒绝, 不写库', async (_, body) => {
    await expect(post(body())).resolves.toBe(INVALID_LINK)

    expect(userUpdateManyMock).not.toHaveBeenCalled()
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })

  it.each([
    ['令牌长度不对', { uid: 42, token: 'short' }],
    ['id 不是正整数', { uid: 0, token: 'A'.repeat(32) }],
    ['id 带小数', { uid: 4.2, token: 'A'.repeat(32) }],
    ['id 超出 int4', { uid: 2147483648, token: 'A'.repeat(32) }],
    ['什么都没带', {}],
    ['请求体不是对象', null]
  ])('%s的请求在解析时就被拒绝', async (_, body) => {
    await expect(post(body)).resolves.toBe(INVALID_LINK)

    expect(userUpdateManyMock).not.toHaveBeenCalled()
    expect(getKvMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/auth/email-notice/disable 凭旧邮件里的验证码', () => {
  const body = { email: 'kun@example.com', validateEmailCode: LEGACY_CODE }

  it('验证码与 Redis 里的一致: 用掉它, 关掉该邮箱所属用户的邮件通知', async () => {
    getKvMock.mockResolvedValue(LEGACY_CODE)
    userFindUniqueMock.mockResolvedValue({ id: 7 })

    await expect(post(body)).resolves.toEqual({})

    expect(getKvMock).toHaveBeenCalledWith('auth:mail:notice:kun@example.com')
    expect(delKvMock).toHaveBeenCalledWith('auth:mail:notice:kun@example.com')
    expect(userUpdateMock).toHaveBeenCalledExactlyOnceWith({
      where: { id: 7 },
      data: { enable_email_notice: false }
    })
    expect(invalidateUserSessionMock).toHaveBeenCalledExactlyOnceWith(7)
  })

  it.each([
    ['已过期或用过', null],
    ['对不上', '11111111-2222-4333-8444-555555555555']
  ])('验证码%s时拒绝, 不消费也不写库', async (_, stored) => {
    getKvMock.mockResolvedValue(stored)

    await expect(post(body)).resolves.toBe(
      '非法的邮箱验证码, 请您登录后在用户设置页面取消邮件订阅'
    )

    expect(delKvMock).not.toHaveBeenCalled()
    expect(userUpdateMock).not.toHaveBeenCalled()
  })

  it('格式不对的旧链接仍回它自己的文案', async () => {
    await expect(
      post({ email: 'not-an-email', validateEmailCode: LEGACY_CODE })
    ).resolves.toBe('非法的邮箱格式')

    expect(getKvMock).not.toHaveBeenCalled()
  })

  it('邮箱已不属于任何用户时回「未找到用户」', async () => {
    getKvMock.mockResolvedValue(LEGACY_CODE)
    userFindUniqueMock.mockResolvedValue(null)

    await expect(post(body)).resolves.toBe('未找到用户')

    expect(userUpdateMock).not.toHaveBeenCalled()
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })
})
