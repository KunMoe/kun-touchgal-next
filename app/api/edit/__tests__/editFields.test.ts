import { describe, expect, it } from 'vitest'
import {
  galgameEditFieldsFromRow,
  galgameEditFingerprint,
  normalizeGalgameEditInput,
  normalizeGalgameExternalIds
} from '../_editFields'

const makeInput = () => ({
  name: '测试 Galgame',
  introduction: '这是一段足够长的游戏介绍文本',
  contentLimit: 'sfw',
  released: '2026-01-01',
  vndbId: 'v19658',
  vndbRelationId: 'r57171',
  bangumiId: '123456',
  steamId: '654321',
  dlsiteCode: 'RJ123456',
  alias: ['别名一', '别名二']
})

const fingerprintOfInput = (input: ReturnType<typeof makeInput>) =>
  galgameEditFingerprint(normalizeGalgameEditInput(input))

// 一次保存落库之后再读出来的行: 写入用的就是规范化之后的值, 别名按写入顺序回读
const rowAfterSaving = (input: ReturnType<typeof makeInput>) => {
  const saved = normalizeGalgameEditInput(input)
  return {
    name: saved.name,
    introduction: saved.introduction,
    content_limit: saved.contentLimit,
    released: saved.released,
    vndb_id: saved.vndbId,
    vndb_relation_id: saved.vndbRelationId,
    bangumi_id: saved.bangumiId,
    steam_id: saved.steamId,
    dlsite_code: saved.dlsiteCode,
    alias: saved.alias.map((name) => ({ name }))
  }
}

describe('normalizeGalgameExternalIds', () => {
  it('把提交值变成库里的值: 大小写、首尾空白、空值存 NULL、数字列存数字', () => {
    expect(
      normalizeGalgameExternalIds({
        vndbId: ' V19658 ',
        vndbRelationId: 'R57171',
        bangumiId: '123456',
        steamId: '',
        dlsiteCode: ' rj123456'
      })
    ).toEqual({
      vndbId: 'v19658',
      vndbRelationId: 'r57171',
      bangumiId: 123456,
      steamId: null,
      dlsiteCode: 'RJ123456'
    })
  })

  it('缺省与 null 都按未填处理', () => {
    expect(normalizeGalgameExternalIds({ vndbId: null })).toEqual({
      vndbId: null,
      vndbRelationId: null,
      bangumiId: null,
      steamId: null,
      dlsiteCode: null
    })
  })
})

describe('normalizeGalgameEditInput', () => {
  it('名字与介绍去掉首尾空白, 别名 trim 后去重并保持顺序', () => {
    const fields = normalizeGalgameEditInput({
      ...makeInput(),
      name: '  测试 Galgame ',
      introduction: '\n这是一段足够长的游戏介绍文本\n\n',
      alias: ['LOOPERS', ' ルーパーズ ', 'LOOPERS', '']
    })

    expect(fields.name).toBe('测试 Galgame')
    expect(fields.introduction).toBe('这是一段足够长的游戏介绍文本')
    expect(fields.alias).toEqual(['LOOPERS', 'ルーパーズ'])
  })
})

describe('galgameEditFingerprint', () => {
  it('是 64 位十六进制小写, 同样的字段得到同样的值', () => {
    const fingerprint = fingerprintOfInput(makeInput())

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprintOfInput(makeInput())).toBe(fingerprint)
  })

  it.each([
    ['name', { name: '另一个名字' }],
    ['introduction', { introduction: '这是另一段足够长的游戏介绍文本' }],
    ['contentLimit', { contentLimit: 'nsfw' }],
    ['released', { released: '2026-01-02' }],
    ['vndbId', { vndbId: 'v1' }],
    ['vndbRelationId', { vndbRelationId: '' }],
    ['bangumiId', { bangumiId: '1' }],
    ['steamId', { steamId: '' }],
    ['dlsiteCode', { dlsiteCode: 'VJ012345' }],
    ['alias', { alias: ['别名一'] }]
  ])('%s 变了指纹就变', (_, changed) => {
    expect(fingerprintOfInput({ ...makeInput(), ...changed })).not.toBe(
      fingerprintOfInput(makeInput())
    )
  })

  it('别名的顺序是指纹的一部分', () => {
    expect(
      fingerprintOfInput({ ...makeInput(), alias: ['别名二', '别名一'] })
    ).not.toBe(fingerprintOfInput(makeInput()))
  })

  it('相邻字段的值挪到另一个字段里不会撞出同一个指纹', () => {
    expect(
      fingerprintOfInput({ ...makeInput(), name: 'a', introduction: 'b,c' })
    ).not.toBe(
      fingerprintOfInput({ ...makeInput(), name: 'a,b', introduction: 'c' })
    )
    expect(fingerprintOfInput({ ...makeInput(), alias: ['a', 'b'] })).not.toBe(
      fingerprintOfInput({ ...makeInput(), alias: ['a,b'] })
    )
  })

  it('只差首尾空白、外部 ID 大小写、别名重复的提交规范化后指纹相同', () => {
    expect(
      fingerprintOfInput({
        ...makeInput(),
        name: ' 测试 Galgame ',
        introduction: '  这是一段足够长的游戏介绍文本\n',
        vndbId: 'V19658',
        vndbRelationId: ' R57171',
        dlsiteCode: 'rj123456',
        alias: ['别名一', ' 别名二 ', '别名一']
      })
    ).toBe(fingerprintOfInput(makeInput()))
  })
})

// 重试放行靠的是这条: 一次保存落库之后, 库里读出来的值与那次提交的规范化结果指纹相同
describe('库里的行与提交值的指纹', () => {
  it('保存之后回读的行与那次提交的指纹相同', () => {
    const input = {
      ...makeInput(),
      name: ' 测试 Galgame ',
      vndbId: 'V19658',
      steamId: '',
      alias: ['别名一', '别名一', ' 别名二']
    }

    expect(
      galgameEditFingerprint(galgameEditFieldsFromRow(rowAfterSaving(input)))
    ).toBe(fingerprintOfInput(input))
  })

  it('库里的值原样进指纹: 历史数据里首尾带空白的名字与去掉空白的提交不相同', () => {
    const row = { ...rowAfterSaving(makeInput()), name: ' 测试 Galgame' }

    expect(galgameEditFingerprint(galgameEditFieldsFromRow(row))).not.toBe(
      fingerprintOfInput(makeInput())
    )
  })
})
