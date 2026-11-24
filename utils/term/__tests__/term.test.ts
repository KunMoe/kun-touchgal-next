import { describe, expect, it } from 'vitest'
import {
  aliasKey,
  aliasLookupForms,
  aliasLookupFormsOf,
  normalizeAliasList
} from '~/utils/term/normalize'
import { parseSearchTerms } from '~/utils/term/parseSearchTerms'

describe('aliasKey', () => {
  it('去首尾空白 (含全角空格) 后转小写', () => {
    expect(aliasKey('  Key Visual　')).toBe('key visual')
  })

  it('全角拉丁字母也转小写, 不做全半角折叠', () => {
    expect(aliasKey('ＫＥＹ')).toBe('ｋｅｙ')
  })

  it('空白串得到空串', () => {
    expect(aliasKey(' \t ')).toBe('')
  })
})

describe('normalizeAliasList', () => {
  it('逐项规范化, 去空, 按首次出现的位置去重', () => {
    expect(normalizeAliasList(['B', ' a ', '', 'b', 'A', '  '])).toEqual([
      'b',
      'a'
    ])
  })
})

describe('aliasLookupForms', () => {
  it('已是规范形时只有一种形态', () => {
    expect(aliasLookupForms(' key ')).toEqual(['key'])
  })

  it('带大写时同时给出原串与规范形, 原串在前', () => {
    expect(aliasLookupForms(' Key ')).toEqual(['Key', 'key'])
  })

  it('一组输入的形态合并去重', () => {
    expect(aliasLookupFormsOf(['Key', 'key', 'ABC'])).toEqual([
      'Key',
      'key',
      'ABC',
      'abc'
    ])
  })
})

describe('parseSearchTerms', () => {
  it('按任意空白切分, 含全角空格与连续空白', () => {
    expect(parseSearchTerms('  纯爱　校园   催泪\t')).toEqual([
      '纯爱',
      '校园',
      '催泪'
    ])
  })

  it('空串与纯空白得到空数组', () => {
    expect(parseSearchTerms('')).toEqual([])
    expect(parseSearchTerms(' 　 ')).toEqual([])
  })

  it('恰好 10 组放行, 第 11 组返回与服务端相同的错误消息', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `t${i}`)
    expect(parseSearchTerms(ten.join(' '))).toEqual(ten)
    expect(parseSearchTerms([...ten, 't10'].join(' '))).toBe(
      '您最多使用 10 组关键词'
    )
  })
})
