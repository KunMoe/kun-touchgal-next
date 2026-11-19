import { describe, expect, it } from 'vitest'
import { patchCreateSchema, patchUpdateSchema } from '~/validations/edit'

// patch.bangumi_id / steam_id 是 int4 列。仅 max(10) 会放行 2147483648 ~ 9999999999，
// 这些值进入 Prisma 后抛 P2020 而非业务错误字符串，冒泡成 500
describe('外部 ID 的 int4 范围校验', () => {
  const cases = [
    { schema: patchCreateSchema, schemaName: 'create', field: 'bangumiId' },
    { schema: patchCreateSchema, schemaName: 'create', field: 'steamId' },
    { schema: patchUpdateSchema, schemaName: 'update', field: 'bangumiId' },
    { schema: patchUpdateSchema, schemaName: 'update', field: 'steamId' }
  ] as const

  cases.forEach(({ schema, schemaName, field }) => {
    const parseField = (value: string) => schema.shape[field].safeParse(value)

    it(`${schemaName}.${field} 拒绝超出 int4 的值`, () => {
      expect(parseField('9999999999').success).toBe(false)
      expect(parseField('2147483648').success).toBe(false)
    })

    it(`${schemaName}.${field} 接受 int4 边界值与常见真实 ID`, () => {
      expect(parseField('2147483647').success).toBe(true)
      expect(parseField('427846').success).toBe(true)
    })

    it(`${schemaName}.${field} 保持留空可选`, () => {
      expect(parseField('').success).toBe(true)
    })

    it(`${schemaName}.${field} 仍拒绝非纯数字`, () => {
      expect(parseField('abc').success).toBe(false)
    })
  })
})

// patch_tag.name 是 VarChar(107) 而 patch_alias.name 是 VarChar(1007)。标签上限
// 若放行 108+ 字符, 会在 patch 主事务提交后的 batchTag 才抛 22001 冒泡成 500
describe('update 标签与别名的长度上限', () => {
  it('addTagNames 拒绝超过 107 字符的元素', () => {
    expect(
      patchUpdateSchema.shape.addTagNames.safeParse(['x'.repeat(108)]).success
    ).toBe(false)
  })

  it('addTagNames 接受 107 字符边界值', () => {
    expect(
      patchUpdateSchema.shape.addTagNames.safeParse(['x'.repeat(107)]).success
    ).toBe(true)
  })

  it('addTagNames 的元素先 trim, 只剩空白的拒绝', () => {
    expect(patchUpdateSchema.shape.addTagNames.parse([' 纯爱 '])).toEqual([
      '纯爱'
    ])
    expect(patchUpdateSchema.shape.addTagNames.safeParse(['  ']).success).toBe(
      false
    )
  })

  it('alias 保持 500 上限不随标签一并收紧', () => {
    expect(
      patchUpdateSchema.shape.alias.safeParse(['x'.repeat(500)]).success
    ).toBe(true)
    expect(
      patchUpdateSchema.shape.alias.safeParse(['x'.repeat(501)]).success
    ).toBe(false)
  })
})

// PUT 的手动标签按差量提交, 不再回传现存标签的全集: 新增与 POST 的手动标签同为 100;
// 移除至多是全部现存标签 (快照中单个 Galgame 最多 165 个), 1000 只是单请求的成本上界
describe('update 标签差量与别名的条数上限', () => {
  it('removeTagIds 接受 165 个元素 (清空标签最多的那个 Galgame)', () => {
    const ids = Array.from({ length: 165 }, (_, i) => i + 1)
    expect(patchUpdateSchema.shape.removeTagIds.safeParse(ids).success).toBe(
      true
    )
  })

  it('removeTagIds 接受 1000 个元素并拒绝 1001 个', () => {
    const build = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
    expect(
      patchUpdateSchema.shape.removeTagIds.safeParse(build(1000)).success
    ).toBe(true)
    expect(
      patchUpdateSchema.shape.removeTagIds.safeParse(build(1001)).success
    ).toBe(false)
  })

  it('addTagNames 接受 100 个元素并拒绝 101 个 (与 POST 口径一致)', () => {
    const build = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)
    expect(
      patchUpdateSchema.shape.addTagNames.safeParse(build(100)).success
    ).toBe(true)
    expect(
      patchUpdateSchema.shape.addTagNames.safeParse(build(101)).success
    ).toBe(false)
  })

  it('两项都可以是空数组: 空差量即不动', () => {
    expect(patchUpdateSchema.shape.removeTagIds.safeParse([]).success).toBe(
      true
    )
    expect(patchUpdateSchema.shape.addTagNames.safeParse([]).success).toBe(true)
  })

  it('alias 接受 100 个元素并拒绝 101 个 (与 POST 口径一致)', () => {
    const build = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`)
    expect(patchUpdateSchema.shape.alias.safeParse(build(100)).success).toBe(
      true
    )
    expect(patchUpdateSchema.shape.alias.safeParse(build(101)).success).toBe(
      false
    )
  })
})

// patch_tag.id 是 int4: 越界的值进了查询抛 P2020, 冒泡成 500
describe('update removeTagIds 的元素', () => {
  const parse = (value: unknown) =>
    patchUpdateSchema.shape.removeTagIds.safeParse([value])

  it('接受正整数直到 int4 上界', () => {
    expect(parse(1).success).toBe(true)
    expect(parse(2147483647).success).toBe(true)
  })

  it('拒绝超出 int4 的值', () => {
    expect(parse(2147483648).success).toBe(false)
  })

  it.each([0, -1, 1.5, Number.NaN, '12', null])('拒绝 %s', (value) => {
    expect(parse(value).success).toBe(false)
  })
})

// 指纹是 sha256 的十六进制小写; 形状不对的直接拒绝, 不拿去和库里的值比
describe('update baseFingerprint', () => {
  const parse = (value: unknown) =>
    patchUpdateSchema.shape.baseFingerprint.safeParse(value)

  it('接受 64 位十六进制小写', () => {
    expect(parse('0123456789abcdef'.repeat(4)).success).toBe(true)
  })

  it.each([
    ['缺省', undefined],
    ['空串', ''],
    ['63 位', 'a'.repeat(63)],
    ['65 位', 'a'.repeat(65)],
    ['大写', 'A'.repeat(64)],
    ['非十六进制', 'g'.repeat(64)]
  ])('拒绝%s', (_, value) => {
    expect(parse(value).success).toBe(false)
  })

  it('旧页面按旧协议发来的请求校验失败, 不会被当成无条件覆盖', () => {
    const result = patchUpdateSchema.safeParse({
      id: 5,
      name: '测试 Galgame',
      vndbId: '',
      vndbRelationId: '',
      bangumiId: '',
      steamId: '',
      dlsiteCode: '',
      introduction: '这是一段足够长的游戏介绍文本',
      // 旧协议: 现存标签的名字全集
      tag: ['标签一'],
      alias: [],
      contentLimit: 'sfw',
      released: ''
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path[0])).toEqual(
      expect.arrayContaining(['removeTagIds', 'addTagNames', 'baseFingerprint'])
    )
  })
})

// create 侧 tag/alias 是 JSON 字符串, 超 2333 的错误消息曾把字段名写成「别名」
// 且数值写成 3000, 与 max(2333) 不符
describe('create 标签与别名字符串总长度的错误消息', () => {
  it('tag 超过 2333 字符时消息指向标签且数值为 2333', () => {
    const result = patchCreateSchema.shape.tag.safeParse('x'.repeat(2334))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe(
      '标签字符串总长度不可超过 2333 个字符'
    )
  })

  it('alias 超过 2333 字符时消息数值为 2333', () => {
    const result = patchCreateSchema.shape.alias.safeParse('x'.repeat(2334))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe(
      '别名字符串总长度不可超过 2333 个字符'
    )
  })
})

// patch.name 是 VarChar(1007)、patch.released 是 VarChar(107)。schema 若不设上限,
// 超长值会在 patch.create/update 抛 22001 冒泡成 500 而非本地化错误消息
describe('name 与 released 的长度上限', () => {
  const cases = [
    { schema: patchCreateSchema, schemaName: 'create' },
    { schema: patchUpdateSchema, schemaName: 'update' }
  ] as const

  cases.forEach(({ schema, schemaName }) => {
    it(`${schemaName}.name 接受 1007 字符边界值并拒绝 1008`, () => {
      expect(schema.shape.name.safeParse('x'.repeat(1007)).success).toBe(true)
      expect(schema.shape.name.safeParse('x'.repeat(1008)).success).toBe(false)
    })

    it(`${schemaName}.released 接受 107 字符边界值并拒绝 108`, () => {
      expect(schema.shape.released.safeParse('x'.repeat(107)).success).toBe(
        true
      )
      expect(schema.shape.released.safeParse('x'.repeat(108)).success).toBe(
        false
      )
    })
  })

  it('update.released 保持可选', () => {
    expect(patchUpdateSchema.shape.released.safeParse(undefined).success).toBe(
      true
    )
  })
})

// schema 未声明的键会被 zod 静默剥掉, 服务端就收不到 DLsite 标签
describe('dlsiteTags 字段', () => {
  it('create 把 FormData 里的 JSON 字符串解析为数组', () => {
    expect(patchCreateSchema.shape.dlsiteTags.parse('["純愛"]')).toEqual([
      '純愛'
    ])
  })

  it('update 接受数组, 缺省时回落为空数组', () => {
    expect(patchUpdateSchema.shape.dlsiteTags.parse(['純愛'])).toEqual(['純愛'])
    expect(patchUpdateSchema.shape.dlsiteTags.parse(undefined)).toEqual([])
  })
})

// Steam 别名由 SteamInput 并入 alias。steamAliases 曾是独立通道, 服务端在 alias 全量
// 同步之后再增量补写, 用户删掉的 Steam 别名提交后又被补回; 旧页面与 localStorage
// 旧草稿仍可能带上这个键, 必须被 schema 剥掉
describe('steamAliases 不再是提交字段', () => {
  const externalIds = {
    name: '测试 Galgame',
    vndbId: '',
    vndbRelationId: '',
    bangumiId: '',
    steamId: '',
    dlsiteCode: '',
    introduction: '这是一段足够长的游戏介绍文本',
    contentLimit: 'sfw',
    released: ''
  }

  it('create 剥掉遗留的 steamAliases 键', () => {
    const parsed = patchCreateSchema.parse({
      ...externalIds,
      banner: new Blob(['x']),
      alias: '["保留的别名"]',
      tag: '[]',
      steamAliases: '["已删除的 Steam 别名"]'
    })
    expect(parsed).not.toHaveProperty('steamAliases')
  })

  it('update 剥掉遗留的 steamAliases 键', () => {
    const parsed = patchUpdateSchema.parse({
      ...externalIds,
      id: 5,
      alias: ['保留的别名'],
      removeTagIds: [],
      addTagNames: [],
      baseFingerprint: '0'.repeat(64),
      steamAliases: ['已删除的 Steam 别名']
    })
    expect(parsed).not.toHaveProperty('steamAliases')
    expect(parsed.alias).toEqual(['保留的别名'])
  })
})
