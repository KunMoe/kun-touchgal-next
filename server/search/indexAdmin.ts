import { isDeepStrictEqual } from 'util'
import type { EnqueuedTaskPromise, Settings } from 'meilisearch'
import { getMeiliClient } from '~/lib/meilisearch'
import { prisma } from '~/prisma/index'
import {
  GALGAME_INDEX,
  GALGAME_INDEX_SETTINGS,
  GALGAME_MAX_TOTAL_HITS
} from './settings'

// 索引定义 (主键与 settings) 只在这里下发: createIndex / updateIndex / updateSettings /
// deleteIndex / swapIndexes 只许出现在本模块。线上定义的权威读数就是 getSettings(),
// 不另存版本号。部署时 pre 阶段在新代码上线之前下发扩张与变更, post 阶段在上线之后下发收缩

export type SettingsDiffKind = 'expand' | 'contract' | 'change'

export interface SettingsDiff {
  key: keyof Settings
  kind: SettingsDiffKind
  expected: unknown
  actual: unknown
}

// v1.15 把这些列表存成集合, getSettings() 返回排序、去重后的值, 只能按集合比较;
// 嵌套的子键用 . 连接。filterableAttributes 返回时保持写入顺序 (可以混有对象形态),
// 顺序同样没有含义
const SET_PATHS = new Set<string>([
  'filterableAttributes',
  'sortableAttributes',
  'stopWords',
  'separatorTokens',
  'nonSeparatorTokens',
  'dictionary',
  'typoTolerance.disableOnAttributes',
  'typoTolerance.disableOnWords'
])

// 顺序即语义: 检索字段的先后是权重, 排序规则的先后是优先级
const ORDERED_KEYS = new Set<string>(['searchableAttributes', 'rankingRules'])

// 整个值就是数据: 声明 {} 也要能发现线上多出的同义词。其余对象只比较声明了的子键,
// 引擎会给没声明的子键补默认值 (typoTolerance.disableOnNumbers、faceting …)
const WHOLE_VALUE_PATHS = new Set<string>(['synonyms'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// null 与缺省 (旧引擎不认识这个键) 都按空列表
const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : []

const includesValue = (list: unknown[], value: unknown) =>
  list.some((item) => isDeepStrictEqual(item, value))

const diffSet = (expected: unknown, actual: unknown) => {
  const want = asList(expected)
  const have = asList(actual)
  const added = want.filter((item) => !includesValue(have, item))
  const removed = have.filter((item) => !includesValue(want, item))
  if (added.length === 0 && removed.length === 0) {
    return null
  }
  // filterableAttributes 自 v1.14 起可写成 { attributePatterns, features }。同一个字段从
  // 字符串改成对象、或只改 features, 按值比较都是一增一删, 分不清是增删字段还是改能力,
  // 所以只要差异里有对象就算 change
  if ([...added, ...removed].some((item) => typeof item !== 'string')) {
    return 'change'
  }
  if (removed.length === 0) {
    return 'expand'
  }
  return added.length === 0 ? 'contract' : 'change'
}

// sub 的元素按原有先后全部出现在 full 里
const isSubsequence = (sub: unknown[], full: unknown[]) => {
  let matched = 0
  for (const item of full) {
    if (matched < sub.length && isDeepStrictEqual(item, sub[matched])) {
      matched++
    }
  }
  return matched === sub.length
}

const diffOrdered = (expected: unknown, actual: unknown) => {
  const want = asList(expected)
  const have = asList(actual)
  if (isDeepStrictEqual(want, have)) {
    return null
  }
  if (isSubsequence(have, want)) {
    return 'expand'
  }
  return isSubsequence(want, have) ? 'contract' : 'change'
}

const sameDeclared = (
  expected: unknown,
  actual: unknown,
  path: string
): boolean => {
  if (SET_PATHS.has(path)) {
    return diffSet(expected, actual) === null
  }
  if (isRecord(expected) && !WHOLE_VALUE_PATHS.has(path)) {
    return (
      isRecord(actual) &&
      Object.entries(expected).every(([key, value]) =>
        sameDeclared(value, actual[key], `${path}.${key}`)
      )
    )
  }
  return isDeepStrictEqual(expected, actual)
}

const diffKind = (
  key: keyof Settings,
  expected: unknown,
  actual: unknown
): SettingsDiffKind | null => {
  if (SET_PATHS.has(key)) {
    return diffSet(expected, actual)
  }
  if (ORDERED_KEYS.has(key)) {
    return diffOrdered(expected, actual)
  }
  return sameDeclared(expected, actual, key) ? null : 'change'
}

// 只比较 expected 里声明了的键: getSettings() 会带回全部键的默认值
// (displayedAttributes、embedders、proximityPrecision …), 它们不是代码的定义
export const diffIndexSettings = (
  expected: Settings,
  actual: Settings
): SettingsDiff[] => {
  const diffs: SettingsDiff[] = []
  for (const key of Object.keys(expected) as (keyof Settings)[]) {
    const kind = diffKind(key, expected[key], actual[key])
    if (kind) {
      diffs.push({ key, kind, expected: expected[key], actual: actual[key] })
    }
  }
  return diffs
}

export interface EnsureSearchIndexReport {
  // 这次调用建出了索引 (只在 apply 模式下可能)
  created: boolean
  // 索引不存在且 mode 为 check
  missing: boolean
  // 下发之前发现的差异
  diffs: SettingsDiff[]
  // 这次下发了的差异 (check 模式恒为空)
  applied: SettingsDiff[]
  patchCount: number
  maxTotalHits: number
}

// settings 变更会让引擎重建索引 (本地 1.5 万文档: 加 sortable 0.3 秒, 改 stopWords 6 秒,
// 整套 settings 下到默认索引上 8 秒), 任务还要排在已入队的任务之后, 上限按生产最坏情况留足
const INDEX_TASK_TIMEOUT_MS = 600_000

const PHASE_KINDS: Record<'pre' | 'post', readonly SettingsDiffKind[]> = {
  // 任务成功之前引擎一直按旧 settings 服务, 按新字段排序会被拒 (invalid_search_sort),
  // 所以新代码要用的字段在它上线之前下发并等到任务成功; 旧代码照常可用
  pre: ['expand', 'change'],
  // 去掉旧代码还在用的字段, 等新代码上线之后
  post: ['contract']
}

// 精确总数、深分页与相关性阈值下的计数查询 (query.ts) 都以 maxTotalHits 为上限,
// patch 条数达到它之后总数与翻页会被静默截断。只告警不抛错 (settings 照常下发), 由
// scripts/search/ensure.ts 据报告里的条数非零退出
const TOTAL_HITS_WARN_RATIO = 0.9

const warnTotalHitsHeadroom = (patchCount: number) => {
  const usage = `patch 条数 ${patchCount} / maxTotalHits ${GALGAME_MAX_TOTAL_HITS}`
  if (patchCount >= GALGAME_MAX_TOTAL_HITS) {
    // eslint-disable-next-line no-console
    console.error(
      `[kun-search] ${usage}: 搜索总数与深分页已被截断, 调大 server/search/settings.ts 的 GALGAME_MAX_TOTAL_HITS 后运行 pnpm search:ensure --apply`
    )
  } else if (patchCount >= GALGAME_MAX_TOTAL_HITS * TOTAL_HITS_WARN_RATIO) {
    // eslint-disable-next-line no-console
    console.warn(
      `[kun-search] ${usage} 已超过 ${TOTAL_HITS_WARN_RATIO * 100}%, 尽快调大 GALGAME_MAX_TOTAL_HITS`
    )
  }
}

const isIndexNotFound = (error: unknown) => {
  const { name, cause } = (
    typeof error === 'object' && error !== null ? error : {}
  ) as { name?: unknown; cause?: { code?: unknown } | null }
  // 按 name 与错误码判别, 不用 instanceof (见 failure.ts)
  return name === 'MeilisearchApiError' && cause?.code === 'index_not_found'
}

const waitIndexTask = (enqueued: EnqueuedTaskPromise) =>
  enqueued.waitTask({ timeout: INDEX_TASK_TIMEOUT_MS })

const requireSucceeded = async (
  enqueued: EnqueuedTaskPromise,
  action: string
) => {
  const task = await waitIndexTask(enqueued)
  if (task.status !== 'succeeded') {
    throw new Error(
      `${action}失败 (任务 ${task.uid}, ${task.status}): ${JSON.stringify(task.error)}`
    )
  }
}

// check 只读; apply 按 phase 下发差异, 不传 phase 时全部下发 (新环境)。
// 未配置 Meilisearch 返回 null
export const ensureSearchIndex = async (opts: {
  mode: 'check' | 'apply'
  phase?: 'pre' | 'post'
}): Promise<EnsureSearchIndexReport | null> => {
  const client = getMeiliClient()
  if (!client) {
    return null
  }
  const index = client.index(GALGAME_INDEX)

  const patchCount = await prisma.patch.count()
  warnTotalHitsHeadroom(patchCount)
  const counts = { patchCount, maxTotalHits: GALGAME_MAX_TOTAL_HITS }

  let info = await index.getRawInfo().catch((error: unknown) => {
    if (isIndexNotFound(error)) {
      return null
    }
    throw error
  })
  let created = false
  // 新建的索引与没有主键的索引里都还没有文档, 没有旧代码依赖它现在的 settings
  let empty = false
  if (!info) {
    if (opts.mode === 'check') {
      return { created, missing: true, diffs: [], applied: [], ...counts }
    }
    const task = await waitIndexTask(
      client.createIndex(GALGAME_INDEX, { primaryKey: 'id' })
    )
    // 读与建之间被别人建好了 (另一次 ensure, 或文档写入自动建索引), 照常往下核对主键
    if (
      task.status !== 'succeeded' &&
      task.error?.code !== 'index_already_exists'
    ) {
      throw new Error(
        `创建索引 ${GALGAME_INDEX} 失败 (任务 ${task.uid}): ${JSON.stringify(task.error)}`
      )
    }
    created = task.status === 'succeeded'
    empty = created
    info = await index.getRawInfo()
  }

  // 主键只能在索引里没有文档时修改。null 是没指定主键建出的空索引, 可以补上: 文档写入
  // 撞上不存在的索引时, 引擎会建出这样的索引, 写入本身因主键推断在 id / uniqueId …
  // 之间失败。别的值说明索引不是本模块建的, 要人确认后删掉重建
  if (info.primaryKey == null) {
    if (opts.mode === 'check') {
      throw new Error(
        `索引 ${GALGAME_INDEX} 没有主键, 运行 pnpm search:ensure --apply 设为 id`
      )
    }
    await requireSucceeded(
      client.updateIndex(GALGAME_INDEX, { primaryKey: 'id' }),
      `索引 ${GALGAME_INDEX} 的主键设置`
    )
    empty = true
  } else if (info.primaryKey !== 'id') {
    throw new Error(
      `索引 ${GALGAME_INDEX} 的主键是 ${info.primaryKey}, 代码要求 id。主键只能在索引为空时修改: 确认后删除这个索引, 再运行 pnpm search:ensure --apply 与 pnpm search:reconcile 重建`
    )
  }

  const diffs = diffIndexSettings(
    GALGAME_INDEX_SETTINGS,
    await index.getSettings()
  )
  // 空索引不分阶段全部下发: 否则 --phase post 撞上空索引会把它留在默认 settings
  const { phase } = opts
  const applied =
    opts.mode === 'apply'
      ? diffs.filter(
          (diff) => !phase || empty || PHASE_KINDS[phase].includes(diff.kind)
        )
      : []
  if (applied.length > 0) {
    // 只下发这一阶段的键: 键与键之间是部分更新, 没下发的键线上保持原样;
    // 整套下发会让留给 post 的收缩提前生效
    const settings: Settings = Object.fromEntries(
      applied.map(({ key }) => [key, GALGAME_INDEX_SETTINGS[key]])
    )
    await requireSucceeded(
      index.updateSettings(settings),
      `索引 ${GALGAME_INDEX} 的 settings 下发`
    )
  }

  return { created, missing: false, diffs, applied, ...counts }
}
