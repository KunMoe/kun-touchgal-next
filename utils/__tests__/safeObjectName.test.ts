import { describe, expect, it } from 'vitest'
import { toSafeObjectName } from '~/utils/safeObjectName'

const nfd = (text: string) => text.normalize('NFD')

describe('toSafeObjectName 保留的名字', () => {
  it.each([
    ['普通名字原样保留', 'game.zip', 'game.zip'],
    ['下划线与连字符保留', 'My_Game-2.7z', 'My_Game-2.7z'],
    ['空格、括号与主名里的点被去掉', '游戏 v1.0 (汉化).zip', '游戏v10汉化.zip'],
    ['只有最后一个点起头的是扩展名', 'game.exe.rar', 'gameexe.rar'],
    ['大写扩展名落成白名单里的小写形式', 'GAME.ZIP', 'GAME.zip'],
    ['数字开头', '2024.zip', '2024.zip']
  ])('%s', (_, raw, expected) => {
    expect(toSafeObjectName(raw)).toBe(expected)
  })
})

describe('toSafeObjectName 归一化 (X06-06)', () => {
  it('日文的分解形式: 浊点、半浊点跟着基字留下', () => {
    const raw = nfd('ガールズ&パッチ.zip')
    expect(raw).not.toBe('ガールズ&パッチ.zip')

    expect(toSafeObjectName(raw)).toBe('ガールズパッチ.zip')
  })

  it('拉丁字母的分解形式: 重音不丢', () => {
    expect(toSafeObjectName(nfd('café.rar'))).toBe('café.rar')
  })

  it('没有合成形式的组合符号照样保留: 天城文的元音符号与 virama', () => {
    expect(toSafeObjectName('हिन्दी.zip')).toBe('हिन्दी.zip')
  })

  it('泰文的声调符号保留', () => {
    expect(toSafeObjectName('น้ำ.zip')).toBe('น้ำ.zip')
  })

  it('不做兼容合成: 全角扩展名不会被折成白名单里的扩展名', () => {
    expect(toSafeObjectName('game.ｚｉｐ')).toBeNull()
  })

  it.each([
    ['点号', 'e.\u0301x.zip'],
    ['空格', 'e \u0301x.zip'],
    ['零宽空格', 'e\u200b\u0301x.zip']
  ])('基字与组合符号之间隔着会被滤掉的%s: 滤掉之后照样合成', (_, raw) => {
    expect(toSafeObjectName(raw)).toBe('\u00e9x.zip')
  })
})

describe('toSafeObjectName 控制符与不可见码点 (9-03 发现 3)', () => {
  it.each([
    ['LF 与路径片段', 'a\n../../b.zip', 'ab.zip'],
    ['CR LF', 'a\r\nb.zip', 'ab.zip'],
    ['行分隔符 U+2028', 'a\u2028b.zip', 'ab.zip'],
    ['段分隔符 U+2029', 'a\u2029b.zip', 'ab.zip'],
    ['NUL', 'a\u0000b.zip', 'ab.zip'],
    ['零宽空格', 'ga\u200bme.zip', 'game.zip'],
    ['从右到左覆盖符', 'evil\u202etxt.zip', 'eviltxt.zip'],
    ['扩展名之后的换行', 'game.zip\n', 'game.zip'],
    ['扩展名之后的行分隔符', 'game.zip\u2028', 'game.zip'],
    ['扩展名之后的段分隔符', 'game.zip\u2029', 'game.zip'],
    ['扩展名中间的零宽空格', 'game.z\u200bip', 'game.zip']
  ])('%s被剥掉, 不再原样放行', (_, raw, expected) => {
    expect(toSafeObjectName(raw)).toBe(expected)
  })

  it('不可见的「文字」不算文字: 韩文填充符撑不起一个名字', () => {
    expect(toSafeObjectName('\u3164\u3164.zip')).toBeNull()
  })
})

describe('toSafeObjectName 截断 (X17-02)', () => {
  it('主名按码点截到 100', () => {
    expect(toSafeObjectName(`${'あ'.repeat(150)}.zip`)).toBe(
      `${'あ'.repeat(100)}.zip`
    )
  })

  it.each([
    ['奇数对齐', `a${'𠮷'.repeat(120)}.zip`, `a${'𠮷'.repeat(99)}.zip`],
    ['偶数对齐', `${'𠮷'.repeat(120)}.zip`, `${'𠮷'.repeat(100)}.zip`]
  ])('平面外文字%s: 切点不落在代理对中间', (_, raw, expected) => {
    const name = toSafeObjectName(raw)

    expect(name).toBe(expected)
    expect(name!.isWellFormed()).toBe(true)
    expect(() => encodeURIComponent(name!)).not.toThrow()
  })

  it('输入里的孤立代理被滤掉, 结果仍是合法字符串', () => {
    const name = toSafeObjectName('a\ud83db.zip')

    expect(name).toBe('ab.zip')
    expect(name!.isWellFormed()).toBe(true)
  })

  it('恰好 100 个码点不截断', () => {
    const raw = `${'a'.repeat(100)}.zip`

    expect(toSafeObjectName(raw)).toBe(raw)
  })
})

describe('toSafeObjectName 拒绝 (返回 null)', () => {
  it.each([
    ['扩展名不在白名单', 'game.exe'],
    ['白名单扩展名不在末尾', 'game.zip.exe'],
    ['没有扩展名', 'archive'],
    ['以点结尾', 'archive.'],
    ['扩展名后跟着空格', 'game.zip '],
    ['空串', ''],
    ['主名为空', '.zip'],
    ['主名只有符号', '【】!!.zip'],
    ['主名全是 emoji', '😀😀.zip'],
    ['带变体选择符的 emoji', '❤\ufe0f☀\ufe0f.zip'],
    ['键帽 emoji 的残片', '#\ufe0f\u20e3.zip'],
    ['只有组合符号', '\u0301.zip'],
    ['只有下划线与连字符', '_-_.zip'],
    ['只有孤立代理', '\ud83d.zip']
  ])('%s', (_, raw) => {
    expect(toSafeObjectName(raw)).toBeNull()
  })
})

describe('toSafeObjectName 结果的形状', () => {
  const SAFE_NAME = /^[\p{L}\p{M}\p{N}_-]+\.(zip|rar|7z)$/u
  const samples = [
    'game.zip',
    'GAME.RAR',
    nfd('ガールズ&パッチ.zip'),
    'a\n../../b.zip',
    `a${'𠮷'.repeat(120)}.7z`,
    '<script>alert(1)</script>.zip',
    '..\\..\\windows\\system32.zip',
    'a b\tc%2e%2e/d?e#f.zip',
    '名前 [v2] {final}.rar',
    'e!\u0301.zip'
  ]

  it.each(samples)('%j 的结果只含白名单字符加一个白名单扩展名', (raw) => {
    const name = toSafeObjectName(raw)

    expect(name).toMatch(SAFE_NAME)
    expect(name!.isWellFormed()).toBe(true)
    expect(
      [...name!.slice(0, name!.lastIndexOf('.'))].length
    ).toBeLessThanOrEqual(100)
  })

  it.each(samples)('%j 的结果是合成形式, 再过一遍不变', (raw) => {
    const name = toSafeObjectName(raw)!

    expect(name).toBe(name.normalize('NFC'))
    expect(toSafeObjectName(name)).toBe(name)
  })
})
