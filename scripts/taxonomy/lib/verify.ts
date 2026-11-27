// 资源词表核查的扫描与报告, 入口在 scripts/taxonomy/verify.ts (pnpm taxonomy:verify)。
//
// 第一部分逐行看 patch_resource, 不分 status、发布者与类别, 判据与接口校验的联动是同一个
// findTaxonomyViolations。第二部分看 patch 上由 recalcPatchType 从公开资源聚合出来的三列:
// 资源行改干净之后, 还没重算过的作品仍带着旧值, 并经它们进搜索索引。
// 只发 SELECT, 按 id 分批读, 不开长事务
import { contentStatusLabel } from '~/constants/contentStatus'
import {
  SUPPORTED_LANGUAGE,
  SUPPORTED_PLATFORM,
  SUPPORTED_TYPE
} from '~/constants/resource'
import {
  findTaxonomyViolations,
  isMembershipViolation
} from '~/validations/resourceTaxonomy'
import type { TaxonomyViolation } from '~/validations/resourceTaxonomy'

const BATCH_SIZE = 2000
const SAMPLE_LIMIT = 5

// patch.type 里的 'patch' 不豁免。它有两个来源: 已删除的姊妹站同步任务 (bbe203e8) 打的标记,
// 和 patch_resource.type 的旧值 'patch' 经 recalcPatchType 聚合上来的。资源改掉而作品还没
// 重算时, 两者在数据上分不出, 清法也一样 (重算), 豁免前者就等于放过后者
const PATCH_COLUMNS = [
  ['type', SUPPORTED_TYPE],
  ['language', SUPPORTED_LANGUAGE],
  ['platform', SUPPORTED_PLATFORM]
] as const

const FIELD_LABEL = {
  type: '类型',
  language: '语言',
  platform: '平台',
  emulatorType: '模拟器类型'
} as const

const describeViolation = (violation: TaxonomyViolation): string => {
  switch (violation.kind) {
    case 'unknown-value':
      return violation.field === 'section'
        ? '类别不在词表里'
        : `${FIELD_LABEL[violation.field]}含词表外的值`
    case 'empty':
      return `${FIELD_LABEL[violation.field]}为空`
    case 'section-type':
      return '类型在词表里, 却不属于所在类别'
    case 'emulator-type-required':
      return '平台含模拟器却没有模拟器类型'
    case 'model-name-required':
      return '类型含 AI 补丁却没有模型型号'
    case 'emulator-type-orphan':
      return '平台不含模拟器却留着模拟器类型'
    case 'model-name-orphan':
      return '类型不含 AI 补丁却留着模型型号'
    default:
      return violation satisfies never
  }
}

interface Sample {
  id: number
  // 站内路径, 前面接站点地址就是深链
  path: string
}

interface Tally {
  rows: number
  // 值 → 带着它的行数
  values: Map<string, number>
  // 扫描按 id 升序, 留下的是 id 最小的几行
  samples: Sample[]
}

const newTally = (): Tally => ({ rows: 0, values: new Map(), samples: [] })

const record = (
  tally: Tally,
  sample: Sample,
  values: readonly string[] = []
) => {
  tally.rows++
  for (const value of values) {
    tally.values.set(value, (tally.values.get(value) ?? 0) + 1)
  }
  if (tally.samples.length < SAMPLE_LIMIT) {
    tally.samples.push(sample)
  }
}

const tallyOf = (tallies: Map<string, Tally>, label: string) => {
  let tally = tallies.get(label)
  if (!tally) {
    tally = newTally()
    tallies.set(label, tally)
  }
  return tally
}

export interface TaxonomyReport {
  resources: {
    scanned: number
    clean: number
    // 至少带一条成员违规的行。只有它们拦收尾
    blockingRows: number
    blockingIds: number[]
    blocking: Map<string, Tally>
    // 这些行分布在哪: 「类别 / 发布者 / status」→ 行数, 用来对上该跑哪一份迁移
    blockingSources: Map<string, number>
    // 带着其余违规 (空数组、缺联动字段、孤儿值) 的行, 怎么补由站长逐条裁定。
    // otherOnlyRows 是其中没有成员违规的: 迁移跑完之后还会留下的就是它们
    otherRows: number
    otherOnlyRows: number
    other: Map<string, Tally>
  }
  patches: {
    scanned: number
    blockingRows: number
    blockingIds: number[]
    blocking: Map<string, Tally>
  }
}

// 数组列在库里都可空 (加列之前的存量行就是 NULL), 应用经 Prisma 读到的是空数组, 这里同样处理
type NullableList = string[] | null

interface ResourceRow {
  id: number
  unique_id: string
  user_id: number
  status: number
  section: string
  type: NullableList
  language: NullableList
  platform: NullableList
  emulator_type: NullableList
  model_name: string
}

interface PatchRow {
  id: number
  unique_id: string
  type: NullableList
  language: NullableList
  platform: NullableList
}

interface Queryable {
  query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>
}

const scan = async <Row extends { id: number }>(
  client: Queryable,
  sql: string,
  onRow: (row: Row) => void
) => {
  let cursor = 0
  for (;;) {
    const rows = (await client.query(sql, [cursor, BATCH_SIZE])).rows as Row[]
    for (const row of rows) {
      onRow(row)
    }
    if (rows.length < BATCH_SIZE) {
      return
    }
    cursor = rows[rows.length - 1].id
  }
}

export const verifyResourceTaxonomy = async (
  client: Queryable
): Promise<TaxonomyReport> => {
  const resources: TaxonomyReport['resources'] = {
    scanned: 0,
    clean: 0,
    blockingRows: 0,
    blockingIds: [],
    blocking: new Map(),
    blockingSources: new Map(),
    otherRows: 0,
    otherOnlyRows: 0,
    other: new Map()
  }
  await scan<ResourceRow>(
    client,
    `SELECT r.id, p.unique_id, r.user_id, r.status, r.section, r.type, r.language,
            r.platform, r.emulator_type, r.model_name
       FROM patch_resource r JOIN patch p ON p.id = r.patch_id
      WHERE r.id > $1 ORDER BY r.id LIMIT $2`,
    (row) => {
      resources.scanned++
      const violations = findTaxonomyViolations({
        section: row.section,
        type: row.type ?? [],
        language: row.language ?? [],
        platform: row.platform ?? [],
        emulatorType: row.emulator_type ?? [],
        modelName: row.model_name
      })
      if (violations.length === 0) {
        resources.clean++
        return
      }
      const sample = {
        id: row.id,
        path: `/${row.unique_id}/resource/${row.id}`
      }
      // 判据把词表外的类型同时算作「不属于所在类别」。它们已经记在「类型含词表外的值」里,
      // 这一类只留词表里却放错类别的
      const unknownTypes = violations.flatMap((violation) =>
        violation.kind === 'unknown-value' && violation.field === 'type'
          ? violation.values
          : []
      )
      for (const violation of violations) {
        const values =
          violation.kind === 'section-type'
            ? violation.values.filter((value) => !unknownTypes.includes(value))
            : 'values' in violation
              ? violation.values
              : []
        if (violation.kind === 'section-type' && values.length === 0) {
          continue
        }
        record(
          tallyOf(
            isMembershipViolation(violation)
              ? resources.blocking
              : resources.other,
            describeViolation(violation)
          ),
          sample,
          values
        )
      }
      const blocking = violations.some(isMembershipViolation)
      if (!violations.every(isMembershipViolation)) {
        resources.otherRows++
        resources.otherOnlyRows += blocking ? 0 : 1
      }
      if (!blocking) {
        return
      }
      resources.blockingRows++
      resources.blockingIds.push(row.id)
      const source = [
        row.section,
        row.user_id === 1 ? '官方账号 (user_id 1)' : '其他用户',
        `status ${row.status} ${contentStatusLabel('resource', row.status)}`
      ].join(' / ')
      resources.blockingSources.set(
        source,
        (resources.blockingSources.get(source) ?? 0) + 1
      )
    }
  )

  const patches: TaxonomyReport['patches'] = {
    scanned: 0,
    blockingRows: 0,
    blockingIds: [],
    blocking: new Map()
  }
  await scan<PatchRow>(
    client,
    `SELECT id, unique_id, type, language, platform
       FROM patch WHERE id > $1 ORDER BY id LIMIT $2`,
    (row) => {
      patches.scanned++
      const sample = { id: row.id, path: `/${row.unique_id}` }
      let blocking = false
      for (const [column, vocabulary] of PATCH_COLUMNS) {
        const outside = [
          ...new Set(
            (row[column] ?? []).filter((value) => !vocabulary.includes(value))
          )
        ]
        if (outside.length > 0) {
          blocking = true
          record(
            tallyOf(patches.blocking, `patch.${column} 含词表外的值`),
            sample,
            outside
          )
        }
      }
      if (blocking) {
        patches.blockingRows++
        patches.blockingIds.push(row.id)
      }
    }
  )

  return { resources, patches }
}

export const isTaxonomyVerified = (report: TaxonomyReport) =>
  report.resources.blockingRows === 0 && report.patches.blockingRows === 0

const byCountDesc = (counts: Iterable<[string, number]>) =>
  [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))

const formatSamples = (tally: Tally, siteUrl: string) =>
  tally.samples.map(({ id, path }) => `      样例 ${id}  ${siteUrl}${path}`)

const formatTallies = (tallies: Map<string, Tally>, siteUrl: string) =>
  [...tallies]
    .sort((a, b) => b[1].rows - a[1].rows || (a[0] < b[0] ? -1 : 1))
    .flatMap(([label, tally]) => [
      `    ${label}: ${tally.rows} 行`,
      ...(tally.values.size > 0
        ? [
            `      取值: ${byCountDesc(tally.values)
              .map(([value, rows]) => `${JSON.stringify(value)} ×${rows}`)
              .join(', ')}`
          ]
        : []),
      ...formatSamples(tally, siteUrl)
    ])

export const formatTaxonomyReport = (
  { resources, patches }: TaxonomyReport,
  siteUrl: string
) => [
  `一、patch_resource: 扫描 ${resources.scanned} 行, 无违规 ${resources.clean} 行`,
  `  拦收尾 (值不在词表里, 或类型不属于所在类别): ${resources.blockingRows} 行`,
  ...formatTallies(resources.blocking, siteUrl),
  ...(resources.blockingSources.size > 0
    ? [
        '    这些行的来源 (类别 / 发布者 / status):',
        ...byCountDesc(resources.blockingSources).map(
          ([source, rows]) => `      ${source}: ${rows} 行`
        )
      ]
    : []),
  `  不拦收尾 (行自身不完整, 怎么补逐条裁定): ${resources.otherRows} 行, 其中 ${resources.otherOnlyRows} 行没有上面的问题`,
  ...formatTallies(resources.other, siteUrl),
  '',
  `二、patch 的派生列 type / language / platform: 扫描 ${patches.scanned} 行`,
  `  拦收尾 (含词表外的值; 资源行改干净后对这些作品重跑 recalcPatchType): ${patches.blockingRows} 行`,
  ...formatTallies(patches.blocking, siteUrl)
]

// 完整清单: 迁移与重算要处理的就是这些 id
export const formatBlockingIds = ({ resources, patches }: TaxonomyReport) => [
  `拦收尾的资源 id (${resources.blockingIds.length}):`,
  resources.blockingIds.join(','),
  `拦收尾的作品 id (${patches.blockingIds.length}):`,
  patches.blockingIds.join(',')
]
