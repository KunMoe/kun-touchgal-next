import { describe, expect, it } from 'vitest'
import { normalizeExternalId } from '~/utils/normalizeExternalId'

describe('normalizeExternalId', () => {
  it('VNDB 的两种 ID 去首尾空白并转小写', () => {
    expect(normalizeExternalId('vndb', ' V19658 ')).toBe('v19658')
    expect(normalizeExternalId('vndbRelation', 'R5879')).toBe('r5879')
  })

  it('DLsite 编号去首尾空白并转大写', () => {
    expect(normalizeExternalId('dlsite', ' rj01405813 ')).toBe('RJ01405813')
  })

  it('Bangumi 与 Steam 的纯数字 ID 只去首尾空白', () => {
    expect(normalizeExternalId('bangumi', ' 172612 ')).toBe('172612')
    expect(normalizeExternalId('steam', '3655150')).toBe('3655150')
  })

  it('空值一律得到空串', () => {
    expect(normalizeExternalId('vndb', '   ')).toBe('')
    expect(normalizeExternalId('dlsite', null)).toBe('')
    expect(normalizeExternalId('steam', undefined)).toBe('')
  })
})
