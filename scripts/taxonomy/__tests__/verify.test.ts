import { describe, expect, it, vi } from 'vitest'
import {
  formatBlockingIds,
  formatTaxonomyReport,
  isTaxonomyVerified,
  verifyResourceTaxonomy
} from '~/scripts/taxonomy/lib/verify'

const resource = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  unique_id: `u${id}`,
  section: 'galgame',
  type: ['game'],
  language: ['zh-Hans'],
  platform: ['windows'],
  emulator_type: [],
  model_name: '',
  ...fields
})

const patch = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  unique_id: `p${id}`,
  type: ['game'],
  language: ['zh-Hans'],
  platform: ['windows'],
  ...fields
})

// 按 id 升序、每次至多 limit 行地应答两张表的扫描, 与库的行为一致
const clientOf = (
  resources: ReturnType<typeof resource>[],
  patches: ReturnType<typeof patch>[]
) => ({
  query: vi.fn(async (sql: string, [cursor, limit]: unknown[]) => {
    const table: { id: number }[] = sql.includes('patch_resource')
      ? resources
      : patches
    return {
      rows: table
        .filter((row) => row.id > (cursor as number))
        .slice(0, limit as number)
    }
  })
})

const verify = (
  resources: ReturnType<typeof resource>[],
  patches: ReturnType<typeof patch>[] = []
) => verifyResourceTaxonomy(clientOf(resources, patches))

const tallies = (
  map: Map<string, { rows: unknown[]; values: Map<string, number> }>
) =>
  Object.fromEntries(
    [...map].map(([label, tally]) => [
      label,
      { rows: tally.rows.length, values: Object.fromEntries(tally.values) }
    ])
  )

describe('verifyResourceTaxonomy: patch_resource', () => {
  it('按 id 翻完所有分批, 每一批从上一批最后一行的 id 接着读', async () => {
    const rows = Array.from({ length: 2001 }, (_, index) =>
      resource(index * 3 + 1)
    )
    const client = clientOf(rows, [])
    const { resources } = await verifyResourceTaxonomy(client)

    expect(resources.scanned).toBe(2001)
    expect(resources.clean).toBe(2001)
    expect(
      client.query.mock.calls
        .filter(([sql]) => sql.includes('patch_resource'))
        .map(([, values]) => values)
    ).toEqual([
      [0, 2000],
      [rows[1999].id, 2000]
    ])
  })

  it('词表外的值拦收尾, 按「哪一列」分开计行数与取值', async () => {
    const { resources } = await verify([
      resource(1),
      resource(2, { type: ['pc', 'chinese', 'game'] }),
      resource(3, { type: ['pc'], platform: ['android', 'ios'] }),
      resource(4, { section: 'patch', type: ['patch'] }),
      resource(5, { language: ['chinese'] }),
      resource(6, {
        platform: ['emulator'],
        emulator_type: ['winlator']
      }),
      resource(7, { section: 'tool' })
    ])

    expect(resources).toMatchObject({
      scanned: 7,
      clean: 1,
      blockingRows: 6,
      blockingIds: [2, 3, 4, 5, 6, 7],
      otherRows: 0
    })
    expect(tallies(resources.blocking)).toEqual({
      类型含词表外的值: {
        rows: 3,
        values: { pc: 2, chinese: 1, patch: 1 }
      },
      平台含词表外的值: { rows: 1, values: { android: 1, ios: 1 } },
      语言含词表外的值: { rows: 1, values: { chinese: 1 } },
      模拟器类型含词表外的值: { rows: 1, values: { winlator: 1 } },
      类别不在词表里: { rows: 1, values: { tool: 1 } }
    })
  })

  // 判据把词表外的类型也算作「不属于所在类别」; 报告里它们只记在词表外那一类, 不重复出现
  it('「不属于所在类别」只记词表里却放错类别的类型', async () => {
    const { resources } = await verify([
      resource(1, { type: ['pc'] }),
      resource(2, { type: ['manual', 'pc', 'game'] })
    ])

    expect(tallies(resources.blocking)).toEqual({
      类型含词表外的值: { rows: 2, values: { pc: 2 } },
      '类型在词表里, 却不属于所在类别': { rows: 1, values: { manual: 1 } }
    })
  })

  it('行自身不完整不拦收尾, 单独计数; 没有成员违规的另记一个数', async () => {
    const { resources } = await verify([
      resource(1, { platform: [] }),
      resource(2, { platform: [], type: ['pc'] }),
      resource(3, { platform: ['emulator'] }),
      resource(4, { section: 'patch', type: ['ai'] }),
      resource(5, { emulator_type: ['joiplay'] }),
      resource(6, { model_name: 'GPT-4o' })
    ])

    expect(resources).toMatchObject({
      clean: 0,
      blockingRows: 1,
      blockingIds: [2],
      otherRows: 6,
      otherOnlyRows: 5
    })
    expect(tallies(resources.other)).toEqual({
      平台为空: { rows: 2, values: {} },
      平台含模拟器却没有模拟器类型: { rows: 1, values: {} },
      '类型含 AI 补丁却没有模型型号': { rows: 1, values: {} },
      平台不含模拟器却留着模拟器类型: { rows: 1, values: {} },
      '类型不含 AI 补丁却留着模型型号': { rows: 1, values: {} }
    })
  })

  // 数组列在库里可空 (加列之前的存量行), 应用经 Prisma 读到的是空数组
  it('库里为 NULL 的数组列按空数组处理', async () => {
    const { resources } = await verify([
      resource(1, { emulator_type: null }),
      resource(2, { platform: null })
    ])

    expect(resources.clean).toBe(1)
    expect(tallies(resources.other)).toEqual({
      平台为空: { rows: 1, values: {} }
    })
  })

  // 行数超过一批: 既不按条数截断, 也不只留某一批的
  it('每一类留下全部的行, 按 id 升序, 带站内路径与这一行的值', async () => {
    const ids = Array.from({ length: 2001 }, (_, index) => index * 3 + 1)
    const { resources } = await verify(
      ids.map((id) =>
        resource(id, { platform: id === 4 ? ['ios', 'android'] : ['android'] })
      )
    )

    expect(resources.blocking.get('平台含词表外的值')?.rows).toEqual(
      ids.map((id) => ({
        id,
        path: `/u${id}/resource/${id}`,
        values: id === 4 ? ['ios', 'android'] : ['android']
      }))
    )
  })

  it('一行在几个类别里各记一次, 各带各的值; 没有取值的类别带空数组', async () => {
    const { resources } = await verify([
      resource(7, { type: ['manual', 'pc', 'game'], platform: [] })
    ])
    const rowsOf = (map: typeof resources.blocking) =>
      Object.fromEntries([...map].map(([label, tally]) => [label, tally.rows]))
    const path = '/u7/resource/7'

    expect(rowsOf(resources.blocking)).toEqual({
      类型含词表外的值: [{ id: 7, path, values: ['pc'] }],
      '类型在词表里, 却不属于所在类别': [{ id: 7, path, values: ['manual'] }]
    })
    expect(rowsOf(resources.other)).toEqual({
      平台为空: [{ id: 7, path, values: [] }]
    })
  })
})

describe('verifyResourceTaxonomy: patch 的派生列', () => {
  it('三列各自的词表外的值都拦收尾', async () => {
    const { patches } = await verify(
      [],
      [
        patch(1),
        patch(2, { type: ['chinese', 'game'], platform: ['android'] }),
        patch(4, { language: ['chinese'] }),
        patch(5, { type: null, language: null, platform: null })
      ]
    )

    expect(patches).toMatchObject({
      scanned: 4,
      blockingRows: 2,
      blockingIds: [2, 4]
    })
    expect(tallies(patches.blocking)).toEqual({
      'patch.type 含词表外的值': { rows: 1, values: { chinese: 1 } },
      'patch.platform 含词表外的值': { rows: 1, values: { android: 1 } },
      'patch.language 含词表外的值': { rows: 1, values: { chinese: 1 } }
    })
    expect(patches.blocking.get('patch.language 含词表外的值')?.rows).toEqual([
      { id: 4, path: '/p4', values: ['chinese'] }
    ])
  })

  // 'patch' 可能是已删除的同步任务打的标记, 也可能是旧资源类型聚合上来的: 资源改掉而作品
  // 没重算时两者分不出, 所以一律拦
  it("type 里的 'patch' 同样拦收尾, 不豁免", async () => {
    const { patches } = await verify(
      [],
      [patch(1, { type: ['game', 'patch'] })]
    )

    expect(patches.blockingIds).toEqual([1])
    expect(tallies(patches.blocking)).toEqual({
      'patch.type 含词表外的值': { rows: 1, values: { patch: 1 } }
    })
  })
})

describe('isTaxonomyVerified', () => {
  it.each([
    ['全部干净', [resource(1)], [patch(1)], true],
    ['资源带词表外的值', [resource(1, { type: ['pc'] })], [patch(1)], false],
    [
      '只有派生列带词表外的值',
      [resource(1)],
      [patch(1, { type: ['pc'] })],
      false
    ],
    [
      "只有派生列的 type 带 'patch'",
      [resource(1)],
      [patch(1, { type: ['patch'] })],
      false
    ],
    ['只有不完整的行', [resource(1, { platform: [] })], [patch(1)], true]
  ])('%s', async (_, resources, patches, expected) => {
    expect(isTaxonomyVerified(await verify(resources, patches))).toBe(expected)
  })
})

describe('formatTaxonomyReport', () => {
  it('行数多的类别在前, 取值按行数降序, 每一行给 id、深链与它带着的值', async () => {
    const report = await verify(
      [
        resource(1),
        resource(2, { platform: ['ios', 'android'] }),
        resource(3, { platform: ['android'], type: ['pc'] }),
        resource(4, { platform: [] })
      ],
      [patch(9, { platform: ['android'], type: ['patch'] })]
    )

    expect(formatTaxonomyReport(report, 'https://example.com')).toEqual([
      '一、patch_resource: 扫描 4 行, 无违规 1 行',
      '  拦收尾 (值不在词表里, 或类型不属于所在类别): 2 行',
      '    平台含词表外的值: 2 行',
      '      取值: "android" ×2, "ios" ×1',
      '      2  https://example.com/u2/resource/2  "ios", "android"',
      '      3  https://example.com/u3/resource/3  "android"',
      '    类型含词表外的值: 1 行',
      '      取值: "pc" ×1',
      '      3  https://example.com/u3/resource/3  "pc"',
      '  不拦收尾 (行自身不完整, 怎么补逐条裁定): 1 行, 其中 1 行没有上面的问题',
      '    平台为空: 1 行',
      '      4  https://example.com/u4/resource/4',
      '',
      '二、patch 的派生列 type / language / platform: 扫描 1 行',
      '  拦收尾 (含词表外的值; 资源行改干净后对这些作品重跑 recalcPatchType): 1 行',
      '    patch.platform 含词表外的值: 1 行',
      '      取值: "android" ×1',
      '      9  https://example.com/p9  "android"',
      '    patch.type 含词表外的值: 1 行',
      '      取值: "patch" ×1',
      '      9  https://example.com/p9  "patch"'
    ])
    expect(formatBlockingIds(report)).toEqual([
      '拦收尾的资源 id (2):',
      '2,3',
      '拦收尾的作品 id (1):',
      '9'
    ])
  })

  it('一类有多少行就列多少行, 不截断', async () => {
    const report = await verify(
      Array.from({ length: 12 }, (_, index) =>
        resource(index + 1, { platform: ['android'] })
      ),
      Array.from({ length: 7 }, (_, index) =>
        patch(index + 1, { language: ['chinese'] })
      )
    )
    const lines = formatTaxonomyReport(report, '')

    expect(
      lines.filter((line) => /^ {6}\d+ {2}\/u\d+\/resource\//.test(line))
    ).toEqual(
      Array.from({ length: 12 }, (_, index) => {
        const id = index + 1
        return `      ${id}  /u${id}/resource/${id}  "android"`
      })
    )
    expect(lines.filter((line) => /^ {6}\d+ {2}\/p\d+ /.test(line))).toEqual(
      Array.from(
        { length: 7 },
        (_, index) => `      ${index + 1}  /p${index + 1}  "chinese"`
      )
    )
  })
})
