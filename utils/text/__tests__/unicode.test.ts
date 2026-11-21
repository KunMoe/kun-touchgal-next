import { describe, expect, it } from 'vitest'
import { isWellFormedText, sliceCodePoints, stripInvisible } from '../unicode'

describe('stripInvisible', () => {
  it.each([
    ['ZWSP (Cf 且 Default_Ignorable)', '\u200B'],
    ['ZWJ (Cf 且 Default_Ignorable)', '\u200D'],
    ['SHY', '\u00AD'],
    ['BOM', '\uFEFF'],
    ['双向覆写 RLO', '\u202E'],
    ['INTERLINEAR ANCHOR (只属于 Cf)', '\uFFF9'],
    ['ARABIC NUMBER SIGN (只属于 Cf, 带字形的前置连接符)', '\u0600'],
    ['HANGUL FILLER (只属于 Default_Ignorable)', '\u3164'],
    ['CGJ (只属于 Default_Ignorable)', '\u034F'],
    ['变体选择符 VS16', '\uFE0F'],
    ['平面外的 TAG 字符', '\u{E0041}']
  ])('剥掉 %s', (_name, invisible) => {
    expect(stripInvisible(`加${invisible}微${invisible}信`)).toBe('加微信')
  })

  it('可见字符、空白与平面外字符原样保留', () => {
    const text = 'Hello 世界\n\t１２３ 😀 𠮷'
    expect(stripInvisible(text)).toBe(text)
  })

  it('只含不可见字符时结果为空串', () => {
    expect(stripInvisible('\u200B\u3164\uFFF9\uFE0F')).toBe('')
  })

  it('ZWJ 序列被拆成各个组成 emoji', () => {
    expect(stripInvisible('👨\u200D👩\u200D👧')).toBe('👨👩👧')
  })
})

describe('sliceCodePoints', () => {
  it('BMP 文本按字符数截断', () => {
    expect(sliceCodePoints('汉化补丁说明', 4)).toBe('汉化补丁')
  })

  it('不超长时原样返回', () => {
    expect(sliceCodePoints('abc', 3)).toBe('abc')
    expect(sliceCodePoints('abc', 100)).toBe('abc')
  })

  it('max 为 0 或负数时返回空串', () => {
    expect(sliceCodePoints('abc', 0)).toBe('')
    expect(sliceCodePoints('abc', -1)).toBe('')
  })

  it('平面外字符算一个码点, 切点不劈开代理对', () => {
    const sliced = sliceCodePoints(`a${'😀'.repeat(10)}`, 4)

    expect(sliced).toBe('a😀😀😀')
    expect(sliced.isWellFormed()).toBe(true)
    // String.prototype.slice 在同一位置会留下孤立的高位代理
    expect(`a${'😀'.repeat(10)}`.slice(0, 4).isWellFormed()).toBe(false)
  })

  it('ZWJ 序列按码点计数, 可能在连接符处截断但仍 well-formed', () => {
    const sliced = sliceCodePoints('👨\u200D👩\u200D👧', 2)

    expect(sliced).toBe('👨\u200D')
    expect(sliced.isWellFormed()).toBe(true)
  })

  it('输入里的孤立代理替换为 U+FFFD', () => {
    expect(sliceCodePoints('a\uD83Db\uDE00c', 5)).toBe('a\uFFFDb\uFFFDc')
    expect(sliceCodePoints('ab\uD83D', 3)).toBe('ab\uFFFD')
  })

  it('结果可以无损经过 JSON 往返', () => {
    const sliced = sliceCodePoints(`${'😀'.repeat(5)}\uD83D`, 6)

    expect(JSON.parse(JSON.stringify(sliced))).toBe(sliced)
    expect(JSON.stringify(sliced)).not.toMatch(/\\ud[89ab]/i)
  })
})

describe('isWellFormedText', () => {
  it.each([
    ['空串', ''],
    ['普通文本', 'ATRI -My Dear Moments-'],
    ['中日文', '魔女的夜宴 サノバウィッチ'],
    ['成对的代理 (emoji、扩展区汉字)', '😀𠀀'],
    ['换行与制表符', 'a\nb\tc'],
    ['U+FFFD 本身', 'a\uFFFDb']
  ])('%s: 可以交给下游', (_name, text) => {
    expect(isWellFormedText(text)).toBe(true)
  })

  it.each([
    ['孤立的高位代理', 'a\uD83Db'],
    ['孤立的低位代理', 'a\uDE00b'],
    ['结尾的孤立高位代理', 'ab\uD83D'],
    ['次序颠倒的代理对', '\uDE00\uD83D'],
    ['NUL', 'a\u0000b'],
    ['只有 NUL', '\u0000']
  ])('%s: 不行', (_name, text) => {
    expect(isWellFormedText(text)).toBe(false)
  })
})
