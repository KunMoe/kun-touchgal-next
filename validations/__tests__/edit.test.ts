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
  it('tag 拒绝超过 107 字符的元素', () => {
    expect(
      patchUpdateSchema.shape.tag.safeParse(['x'.repeat(108)]).success
    ).toBe(false)
  })

  it('tag 接受 107 字符边界值', () => {
    expect(
      patchUpdateSchema.shape.tag.safeParse(['x'.repeat(107)]).success
    ).toBe(true)
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

// PUT 的 tag 承载 patch 全部现存标签(rewrite store 整份灌入 patch.tags, batchTag 全量
// 同步), 条数上限只是单请求成本上界, 不能与 POST 手动标签的 100 对齐: 快照中 91 个
// patch 标签数超过 100, 最大 165, VNDB 单来源可达 132
describe('update 标签与别名的条数上限', () => {
  it('tag 接受 165 个元素 (存量最大值, 上限不可降回 100)', () => {
    const tags = Array.from({ length: 165 }, (_, i) => `标签${i}`)
    expect(patchUpdateSchema.shape.tag.safeParse(tags).success).toBe(true)
  })

  it('tag 接受 1000 个元素并拒绝 1001 个', () => {
    const build = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)
    expect(patchUpdateSchema.shape.tag.safeParse(build(1000)).success).toBe(
      true
    )
    expect(patchUpdateSchema.shape.tag.safeParse(build(1001)).success).toBe(
      false
    )
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
