import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createUnsubscribeUrl,
  signUnsubscribeToken,
  verifyUnsubscribeToken
} from '~/server/mail/unsubscribeToken'
import { disableEmailNoticeSchema } from '~/validations/auth'

beforeEach(() => {
  vi.stubEnv('KUN_EMAIL_UNSUBSCRIBE_SECRET', 'k'.repeat(32))
  vi.stubEnv('NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD', 'https://www.example.com')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('退订令牌', () => {
  it('同一个用户每次签出的令牌相同, 且能通过校验', () => {
    const token = signUnsubscribeToken(42)

    expect(signUnsubscribeToken(42)).toBe(token)
    expect(verifyUnsubscribeToken(42, token)).toBe(true)
  })

  it('令牌是 32 个 URL 安全字符, 与退订请求的 schema 认的形状一致', () => {
    const token = signUnsubscribeToken(42)

    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(
      disableEmailNoticeSchema.safeParse({ uid: '42', token }).data
    ).toEqual({ uid: 42, token })
  })

  it('别的用户的令牌不能用', () => {
    expect(verifyUnsubscribeToken(43, signUnsubscribeToken(42))).toBe(false)
    expect(verifyUnsubscribeToken(42, signUnsubscribeToken(420))).toBe(false)
  })

  it('换了密钥, 之前签出的令牌全部作废', () => {
    const token = signUnsubscribeToken(42)

    vi.stubEnv('KUN_EMAIL_UNSUBSCRIBE_SECRET', 'n'.repeat(32))

    expect(verifyUnsubscribeToken(42, token)).toBe(false)
  })

  it.each([
    ['空串', () => ''],
    ['截掉末位', (token: string) => token.slice(0, -1)],
    ['多出一位', (token: string) => `${token}A`],
    [
      '改了首位',
      (token: string) => `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`
    ],
    [
      '改了末位',
      (token: string) =>
        `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`
    ],
    // 字符数相同、字节数不同
    ['32 个多字节字符', () => '鲲'.repeat(32)],
    // 字节数相同、字符数不同
    ['编码后恰好 32 字节', () => 'é'.repeat(16)]
  ])('被改过的令牌 (%s) 校验不过, 也不抛错', (_, forge) => {
    const forged = forge(signUnsubscribeToken(42))

    expect(verifyUnsubscribeToken(42, forged)).toBe(false)
  })

  it('没配密钥时签发直接抛错, 不会用空密钥签', () => {
    vi.stubEnv('KUN_EMAIL_UNSUBSCRIBE_SECRET', '')

    expect(() => signUnsubscribeToken(42)).toThrow(
      'KUN_EMAIL_UNSUBSCRIBE_SECRET'
    )
    expect(() => verifyUnsubscribeToken(42, 'a'.repeat(32))).toThrow(
      'KUN_EMAIL_UNSUBSCRIBE_SECRET'
    )
  })

  it('退订链接指向落地页, 只带用户 id 与令牌', () => {
    const url = new URL(createUnsubscribeUrl(42))

    expect(`${url.origin}${url.pathname}`).toBe(
      'https://www.example.com/auth/email-notice'
    )
    expect([...url.searchParams.keys()]).toEqual(['u', 't'])
    expect(url.searchParams.get('u')).toBe('42')
    expect(verifyUnsubscribeToken(42, url.searchParams.get('t') ?? '')).toBe(
      true
    )
  })
})
