import { prisma } from '~/prisma/index'
import { markdownToHtml } from '~/app/api/utils/render/markdownToHtml'
import {
  getResourceVisibilityWhere,
  type KunViewer
} from '~/app/api/utils/contentVisibility'
import { GalgameCardSelectField, toGalgameCard } from '~/constants/api/select'
import { mapResource, resourceInclude } from './get'
import type { PatchResource } from '~/types/api/patch'

export interface ResourceDetailOther {
  id: number
  name: string
  section: string
  created: string
  user: {
    name: string
    avatar: string
  }
}

export interface PatchResourceDetail {
  // noteHtml 只在详情页渲染, 列表 / 创建 / 编辑的响应都不带
  resource: PatchResource & { noteHtml: string }
  patchName: string
  contentLimit: string
  galgame: GalgameCard
  otherResources: ResourceDetailOther[]
  isFollowingUploader: boolean
}

// 侧边栏「其他资源」的取数上限, 实际展示条数由客户端按主内容高度动态裁剪
const OTHER_RESOURCES_TAKE = 12

// 资源详情页专用: 单行查询不走共享缓存 (note 的 markdown 渲染自带内容级缓存),
// 可见性与列表一致——status 2/3 仅作者与 role >= 3 可见, 1 前台不可见
export const getPatchResourceDetail = async (
  resourceId: number,
  viewer: KunViewer | null
): Promise<PatchResourceDetail | string> => {
  const uid = viewer?.uid ?? 0

  const data = await prisma.patch_resource.findFirst({
    where: { id: resourceId, ...getResourceVisibilityWhere(viewer) },
    include: {
      ...resourceInclude,
      patch: { select: { ...GalgameCardSelectField, content_limit: true } },
      like_by: { where: { user_id: uid } }
    }
  })
  if (!data) {
    return '未找到该资源'
  }

  // 其他资源与本资源同 patch 同 section, 可见性口径与本资源一致
  const [noteHtml, others, followRelation] = await Promise.all([
    data.note ? markdownToHtml(data.note) : '',
    prisma.patch_resource.findMany({
      where: {
        patch_id: data.patch_id,
        section: data.section,
        id: { not: data.id },
        ...getResourceVisibilityWhere(viewer)
      },
      orderBy: { created: 'desc' },
      take: OTHER_RESOURCES_TAKE,
      select: {
        id: true,
        name: true,
        section: true,
        created: true,
        user: { select: { name: true, avatar: true } }
      }
    }),
    uid && uid !== data.user_id
      ? prisma.user_follow_relation.findUnique({
          where: {
            follower_id_following_id: {
              follower_id: uid,
              following_id: data.user_id
            }
          },
          select: { id: true }
        })
      : null
  ])
  const gal = data.patch
  const galgame = toGalgameCard(gal)

  return {
    resource: { ...mapResource(data, data.like_by.length > 0), noteHtml },
    patchName: gal.name,
    contentLimit: gal.content_limit,
    galgame,
    otherResources: others.map((item) => ({
      id: item.id,
      name: item.name,
      section: item.section,
      created: String(item.created),
      user: item.user
    })),
    isFollowingUploader: Boolean(followRelation)
  }
}
