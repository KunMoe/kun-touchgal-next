import { describe, expect, it } from 'vitest'
import { reservedUsernameMessage } from '~/constants/reserved-usernames.server'
import {
  emailShapedUsernameMessage,
  newUsernameError
} from '~/server/identity/username'

describe('newUsernameError', () => {
  it('保留词', () => {
    expect(newUsernameError('Admin')).toBe(reservedUsernameMessage)
    expect(newUsernameError('admin​')).toBe(reservedUsernameMessage)
  })

  it('邮箱形态', () => {
    expect(newUsernameError('victim@qq.com')).toBe(emailShapedUsernameMessage)
    expect(newUsernameError('Kun.Chan@Example.COM')).toBe(
      emailShapedUsernameMessage
    )
  })

  it('改名规则下的普通名字放行', () => {
    for (const name of [
      'kun',
      'Mr.Pizza',
      'Nihil Contingens',
      'kun@qq',
      '🦌先生'
    ]) {
      expect(newUsernameError(name)).toBeUndefined()
    }
  })
})
