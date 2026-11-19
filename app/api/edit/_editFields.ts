import { createHash } from 'crypto'
import { normalizeExternalId } from '~/utils/normalizeExternalId'
import { normalizeStringArray } from '~/utils/normalizeStringArray'
import type { Prisma } from '~/prisma/generated/prisma/client'

// 一次编辑能改到的字段, 取值与库里存的一模一样。提交值怎样变成库里的值只在本文件定一次:
// 建档、编辑的预检与写入、编辑基线的指纹都从这里取, 各写一份的话, 读基线时与提交时算出的
// 指纹对不上, 没人改过的条目也会报冲突
export interface GalgameEditFields {
  name: string
  introduction: string
  contentLimit: string
  released: string
  vndbId: string | null
  vndbRelationId: string | null
  bangumiId: number | null
  steamId: number | null
  dlsiteCode: string | null
  // 顺序有含义 (第一个别名进详情页的 SEO 信息): 按 patch_alias.id 升序, 即写入时的顺序
  alias: string[]
}

interface GalgameExternalIdInput {
  vndbId?: string | null
  vndbRelationId?: string | null
  bangumiId?: string | null
  steamId?: string | null
  dlsiteCode?: string | null
}

interface GalgameEditInput extends GalgameExternalIdInput {
  name: string
  introduction: string
  contentLimit: string
  released: string
  alias: readonly string[]
}

// bangumi_id / steam_id 是 Int 列: 空串存 NULL, 其余按数字存
const toIntColumn = (value: string) => (value ? Number(value) : null)

export const normalizeGalgameExternalIds = (input: GalgameExternalIdInput) => ({
  vndbId: normalizeExternalId('vndb', input.vndbId) || null,
  vndbRelationId:
    normalizeExternalId('vndbRelation', input.vndbRelationId) || null,
  bangumiId: toIntColumn(normalizeExternalId('bangumi', input.bangumiId)),
  steamId: toIntColumn(normalizeExternalId('steam', input.steamId)),
  dlsiteCode: normalizeExternalId('dlsite', input.dlsiteCode) || null
})

export const normalizeGalgameEditInput = (
  input: GalgameEditInput
): GalgameEditFields => ({
  name: input.name.trim(),
  introduction: input.introduction.trim(),
  contentLimit: input.contentLimit,
  released: input.released,
  ...normalizeGalgameExternalIds(input),
  // patch_alias 无 (patch_id, name) 唯一约束, skipDuplicates 挡不住批内重复, 在这里去重
  alias: normalizeStringArray(input.alias)
})

// 读这些字段一律用这一份 select: 别名的顺序是指纹的一部分, 少了 orderBy 两次读到的顺序
// 可以不同
export const GALGAME_EDIT_SELECT = {
  name: true,
  introduction: true,
  content_limit: true,
  released: true,
  vndb_id: true,
  vndb_relation_id: true,
  bangumi_id: true,
  steam_id: true,
  dlsite_code: true,
  alias: { select: { name: true }, orderBy: { id: 'asc' } }
} satisfies Prisma.patchSelect

type GalgameEditRow = Prisma.patchGetPayload<{
  select: typeof GALGAME_EDIT_SELECT
}>

// 库里的值原样取出, 不再规范化: 历史数据里没按现行规则存的值 (首尾带空白的名字) 也要
// 如实进指纹, 「库里是不是这次提交的值」才判断得准
export const galgameEditFieldsFromRow = (
  row: GalgameEditRow
): GalgameEditFields => ({
  name: row.name,
  introduction: row.introduction,
  contentLimit: row.content_limit,
  released: row.released,
  vndbId: row.vndb_id,
  vndbRelationId: row.vndb_relation_id,
  bangumiId: row.bangumi_id,
  steamId: row.steam_id,
  dlsiteCode: row.dlsite_code,
  alias: row.alias.map((alias) => alias.name)
})

// 编辑的并发令牌: 表单打开时读一次、提交时带回, 服务端在 patch 行锁下与当前值比。
// 不用 patch.updated: 它是 @updatedAt, 下载计数等无关写入也会推进
export const galgameEditFingerprint = (fields: GalgameEditFields): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        fields.name,
        fields.introduction,
        fields.contentLimit,
        fields.released,
        fields.vndbId,
        fields.vndbRelationId,
        fields.bangumiId,
        fields.steamId,
        fields.dlsiteCode,
        fields.alias
      ])
    )
    .digest('hex')
