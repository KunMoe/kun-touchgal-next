import { mergePatchAlias } from '~/utils/mergePatchAlias'
import { normalizeExternalId } from '~/utils/normalizeExternalId'
import { parseCommaSeparatedStringArray } from '~/utils/normalizeStringArray'
import type { KunFormUpdate, PatchFormDataShape } from '~/components/edit/types'
import type { KunExternalIdSource } from '~/utils/normalizeExternalId'

// 外部数据源抓取结果并入表单的规则。全部是纯函数: 入参是「响应到达时」表单的最新状态,
// 不是点击按钮那一刻的快照, 所以请求期间的输入与另一路抓取的结果都还在。
// 并入规则 (别名只追加、发售日期以抓取结果为准、抓取结果为空则保留原值、标签与会社
// 整组替换) 沿用各组件原来的写法

type Form = PatchFormDataShape

const EXTERNAL_ID_FIELD = {
  vndb: 'vndbId',
  vndbRelation: 'vndbRelationId',
  bangumi: 'bangumiId',
  steam: 'steamId',
  dlsite: 'dlsiteCode'
} as const satisfies Record<KunExternalIdSource, keyof Form>

// 请求发出之后 ID 被改掉 (手动改、或另一路抓取回写) 的话, 这份结果已不属于当前表单
const isRequestedIdCurrent = (
  prev: Form,
  source: KunExternalIdSource,
  requestedId: string
) =>
  normalizeExternalId(source, prev[EXTERNAL_ID_FIELD[source]]) === requestedId

export interface VndbFetchResult {
  titles: string[]
  released: string
  tags: string[]
  developers: string[]
}

export const mergeVndbFetch = (
  prev: Form,
  requestedId: string,
  result: VndbFetchResult
): Partial<Form> | null =>
  isRequestedIdCurrent(prev, 'vndb', requestedId)
    ? {
        vndbId: requestedId,
        alias: mergePatchAlias(prev.alias, result.titles, prev.name),
        released: result.released || prev.released,
        vndbTags: result.tags,
        vndbDevelopers: result.developers
      }
    : null

export interface VndbRelationFetchResult extends VndbFetchResult {
  // Release 所属的 VN
  vndbId: string
}

// Release 自己的标题与发售日期排在所属 VN 的前面
export const combineVndbRelationFetch = (
  relation: { vndbId: string; titles: string[]; released: string },
  vn: VndbFetchResult
): VndbRelationFetchResult => ({
  vndbId: relation.vndbId,
  titles: [...new Set([...relation.titles, ...vn.titles])],
  released: relation.released || vn.released,
  tags: vn.tags,
  developers: vn.developers
})

export const mergeVndbRelationFetch = (
  prev: Form,
  requestedId: string,
  result: VndbRelationFetchResult
): Partial<Form> | null =>
  isRequestedIdCurrent(prev, 'vndbRelation', requestedId)
    ? {
        vndbId: result.vndbId,
        vndbRelationId: requestedId,
        alias: mergePatchAlias(prev.alias, result.titles, prev.name),
        released: result.released || prev.released,
        vndbTags: result.tags,
        vndbDevelopers: result.developers
      }
    : null

export interface BangumiFetchResult {
  name: string
  nameCn: string
  released: string
  tags: string[]
  developers: string[]
}

export const mergeBangumiFetch = (
  prev: Form,
  requestedId: string,
  result: BangumiFetchResult
): Partial<Form> | null =>
  isRequestedIdCurrent(prev, 'bangumi', requestedId)
    ? {
        // 回写规范化后的 ID: 带空格的输入抓取得到数据, 原样提交却会被格式校验拒绝
        bangumiId: requestedId,
        alias: mergePatchAlias(
          prev.alias,
          [result.name, result.nameCn],
          prev.name
        ),
        released: result.released || prev.released,
        bangumiTags: result.tags,
        bangumiDevelopers: result.developers
      }
    : null

export interface SteamFetchResult {
  name: string
  aliases: {
    english?: string
    japanese?: string
    tchinese?: string
  }
  releaseDate: string
  tags: string[]
  developers: { name: string; link: string }[]
}

export const steamAliasTitles = (result: SteamFetchResult): string[] =>
  [
    result.aliases.japanese,
    result.aliases.english,
    result.aliases.tchinese
  ].filter((alias): alias is string => !!alias?.trim())

export const mergeSteamFetch = (
  prev: Form,
  requestedId: string,
  result: SteamFetchResult
): Partial<Form> | null =>
  isRequestedIdCurrent(prev, 'steam', requestedId)
    ? {
        steamId: requestedId,
        alias: mergePatchAlias(prev.alias, steamAliasTitles(result), prev.name),
        released: result.releaseDate || prev.released,
        steamTags: result.tags,
        steamDevelopers: result.developers.map((developer) => developer.name)
      }
    : null

export interface DlsiteFetchResult {
  rj_code: string
  title_default: string
  title_jp?: string
  title_en?: string
  release_date?: string
  tags?: string
  circle_name?: string
  circle_link?: string
}

export const parseDlsiteTags = (raw?: string) =>
  parseCommaSeparatedStringArray(raw ?? '')

export const mergeDlsiteFetch = (
  prev: Form,
  requestedId: string,
  result: DlsiteFetchResult
): Partial<Form> | null =>
  isRequestedIdCurrent(prev, 'dlsite', requestedId)
    ? {
        dlsiteCode: requestedId,
        dlsiteCircleName: result.circle_name?.trim() ?? '',
        dlsiteCircleLink: result.circle_link?.trim() ?? '',
        alias: mergePatchAlias(
          prev.alias,
          [result.title_jp, result.title_en].filter(
            (title): title is string => !!title
          ),
          prev.name
        ),
        dlsiteTags: parseDlsiteTags(result.tags),
        released: result.release_date || prev.released
      }
    : null

// 把一次抓取结果并入表单, 返回是否写入。merge 返回 null (这份结果已不属于当前表单)
// 时什么都不写, 调用方据此跳过成功提示。update 同步执行传入的函数, 返回时结果已定
export const applyFetchMerge = (
  update: KunFormUpdate<Form>,
  merge: (prev: Form) => Partial<Form> | null
): boolean => {
  let applied = false
  update((prev) => {
    const patch = merge(prev)
    applied = patch !== null
    return patch ?? {}
  })
  return applied
}

// 抓取之前的阻断式查重只看这一路的外部 ID。标题不参与: 同一部作品的不同版本允许同名
// (服务端也不拦), 拿标题去拦会让重写页 (名字恒有值) 抓不了 Release 数据
export const buildDuplicateCheckQuery = (
  source: KunExternalIdSource,
  normalizedId: string,
  options: { vndbId?: string; excludeId?: number } = {}
): Record<string, string> => ({
  [EXTERNAL_ID_FIELD[source]]: normalizedId,
  // Release 与所属 VN 成对查: 服务端的唯一性是 (vndb_id, vndb_relation_id) 的组合
  ...(source === 'vndbRelation' && options.vndbId
    ? { vndbId: options.vndbId }
    : {}),
  ...(options.excludeId ? { excludeId: String(options.excludeId) } : {})
})

// 预览与「重复条目」这类抓取附带的界面状态: 记下它是为哪个 ID 取的, 渲染时与表单当前
// 的 ID 比对。不用「ID 一变就清空」的 effect: 抓取成功后回写规范化 ID 本身就是一次
// ID 变化, 会把刚拿到的预览清掉
export interface KunFetchedFor<D> {
  forId: string
  data: D
}

export const fetchedForCurrentId = <D>(
  entry: KunFetchedFor<D> | null,
  source: KunExternalIdSource,
  currentId: string
): D | null =>
  entry && entry.forId === normalizeExternalId(source, currentId)
    ? entry.data
    : null
