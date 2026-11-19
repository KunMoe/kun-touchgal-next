import { prisma } from '~/prisma/index'
import {
  GALGAME_EDIT_SELECT,
  galgameEditFieldsFromRow,
  galgameEditFingerprint
} from './_editFields'
import type { GalgameRewriteInitial } from '~/types/api/edit'

// 重新编辑表单的基线。直接读库, 不经 Redis: 详情页那份数据来自 300 秒的共享读缓存, 只适合
// 展示, 拿它当写表单的初值会把陈旧的值写回库里。不按分级或可见性过滤: 能进编辑页的人
// (galgame.rewrite) 本来就能对任意 id 提交修改
export const getGalgameForRewrite = async (
  uniqueId: string
): Promise<GalgameRewriteInitial | null> => {
  const patch = await prisma.patch.findUnique({
    where: { unique_id: uniqueId },
    select: {
      id: true,
      unique_id: true,
      ...GALGAME_EDIT_SELECT,
      tag: {
        select: { tag: { select: { id: true, name: true } } },
        orderBy: { id: 'asc' }
      }
    }
  })
  if (!patch) {
    return null
  }

  const fields = galgameEditFieldsFromRow(patch)
  return {
    id: patch.id,
    uniqueId: patch.unique_id,
    name: fields.name,
    introduction: fields.introduction,
    released: fields.released,
    contentLimit: fields.contentLimit,
    alias: fields.alias,
    externalIds: {
      vndbId: fields.vndbId ?? '',
      vndbRelationId: fields.vndbRelationId ?? '',
      bangumiId: fields.bangumiId === null ? '' : String(fields.bangumiId),
      steamId: fields.steamId === null ? '' : String(fields.steamId),
      dlsiteCode: fields.dlsiteCode ?? ''
    },
    tags: patch.tag.map((relation) => relation.tag),
    baseFingerprint: galgameEditFingerprint(fields)
  }
}
