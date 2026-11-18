import { describe, expect, it } from 'vitest'
import { verifyLogin2FASchema } from '~/validations/auth'

const parse = (token: string, isBackupCode?: boolean) =>
  verifyLogin2FASchema.safeParse({ token, isBackupCode })

const messageOf = (token: string, isBackupCode?: boolean) =>
  parse(token, isBackupCode).error?.issues.map((issue) => issue.message)

describe('login 2FA validation', () => {
  it('keeps TOTP codes as exactly six numeric digits', () => {
    expect(parse('123456', false).success).toBe(true)
    expect(parse('123456').success).toBe(true)
    expect(messageOf('12345', false)).toEqual(['2FA 验证码必须为 6 位数字'])
    // 10 位只在声明为备用验证码时才收
    expect(messageOf('1234567890')).toEqual(['2FA 验证码必须为 6 位数字'])
    expect(messageOf('ABCDEF', false)).toEqual(['2FA 验证码必须为 6 位数字'])
  })

  it('takes backup codes of six digits (issued earlier) or ten digits', () => {
    expect(parse('654321', true).success).toBe(true)
    expect(parse('0123456789', true).success).toBe(true)
    for (const token of ['ABCDEF', '12345', '12345678', '12345678901']) {
      expect(messageOf(token, true)).toEqual([
        '备用验证码必须为 6 位或 10 位数字'
      ])
    }
  })

  it('trims the code and defaults to a TOTP code', () => {
    expect(parse(' 123456 ').data).toEqual({
      token: '123456',
      isBackupCode: false
    })
  })
})
