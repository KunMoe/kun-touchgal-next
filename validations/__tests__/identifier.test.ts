import { describe, expect, it } from 'vitest'
import {
  classifyLoginIdentifier,
  isEmailShaped,
  loginIdentifierSchema
} from '~/validations/identifier'

const LOGIN_MESSAGE = '请输入合法的邮箱格式, 用户名则应为 1~17 位任意字符'

describe('isEmailShaped', () => {
  it('与注册、改邮箱的 zod 邮箱判定一致', () => {
    expect(isEmailShaped('kun@qq.com')).toBe(true)
    expect(isEmailShaped(' Kun.Chan@Example.COM ')).toBe(true)
    expect(isEmailShaped('kun_chan@qq.com')).toBe(true)
  })

  it('注册正则与改名放行的名字都不是邮箱形态', () => {
    // kunUsernameRegex 收 `@` 不收 `.`: 注册取不出邮箱形态的名字
    expect(isEmailShaped('kun@qq')).toBe(false)
    expect(isEmailShaped('Mr.Pizza')).toBe(false)
    expect(isEmailShaped('Nihil Contingens')).toBe(false)
    expect(isEmailShaped('kun')).toBe(false)
    expect(isEmailShaped('')).toBe(false)
  })
})

describe('classifyLoginIdentifier', () => {
  it('邮箱形态判为 email, 其余判为 name', () => {
    expect(classifyLoginIdentifier('kun@qq.com')).toEqual({
      kind: 'email',
      raw: 'kun@qq.com'
    })
    expect(classifyLoginIdentifier('Mr.Pizza')).toEqual({
      kind: 'name',
      raw: 'Mr.Pizza'
    })
  })

  // 验证码的 Redis 键是裸邮箱: 规范化只能在数据库查询里做
  it('只 trim, 不改大小写', () => {
    expect(classifyLoginIdentifier('  Kun@QQ.com ')).toEqual({
      kind: 'email',
      raw: 'Kun@QQ.com'
    })
    expect(classifyLoginIdentifier(' KUN ')).toEqual({
      kind: 'name',
      raw: 'KUN'
    })
  })
})

describe('loginIdentifierSchema', () => {
  it('收邮箱与改名规则下的任意 1~17 个字符', () => {
    for (const value of [
      'kun@qq.com',
      'Mr.Pizza',
      'Nihil Contingens',
      'Turn.',
      '🦌先生',
      '❄️月代雪❄️',
      'k'.repeat(17),
      // 17 个平面外字符 (34 个 UTF-16 码元): 按码点计, 与 zod 的 .max、VarChar(17) 一致
      '𠮷'.repeat(17)
    ]) {
      expect(loginIdentifierSchema.safeParse(value)).toMatchObject({
        success: true,
        data: value
      })
    }
  })

  it('拒绝空串与超长的非邮箱串, 只报一条中文', () => {
    for (const value of [
      '',
      '   ',
      'k'.repeat(18),
      '𠮷'.repeat(18),
      // NUL: 库里存不了, 放过去查询会以 22021 报错
      'a\u0000b'
    ]) {
      const result = loginIdentifierSchema.safeParse(value)
      expect(result.success).toBe(false)
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([
        LOGIN_MESSAGE
      ])
    }
  })

  it('非字符串也报同一条中文', () => {
    expect(
      loginIdentifierSchema.safeParse(42).error?.issues.map((i) => i.message)
    ).toEqual([LOGIN_MESSAGE])
  })

  it('超过 17 个字符的邮箱照收', () => {
    const email = `${'k'.repeat(30)}@example.com`
    expect(loginIdentifierSchema.safeParse(email).success).toBe(true)
  })
})
