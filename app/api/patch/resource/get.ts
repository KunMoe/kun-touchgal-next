import * as z from 'zod'
import { prisma } from '~/prisma/index'
import {
  getResourceVisibilityWhere,
  shouldBypassSharedCache,
  type KunViewer
} from '~/app/api/utils/contentVisibility'
import { kunCacheSingleflight } from '~/app/api/utils/cacheSingleflight'
import {
  getCachedPatchResourceDetail,
  getPatchResourceDetailCacheKey,
  setPatchResourceDetailCache,
  setPatchResourceDetailCacheIfAbsent
} from './cache'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { PatchResource } from '~/types/api/patch'

const patchIdSchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999)
})

export const resourceInclude = {
  patch: { select: { unique_id: true } },
  user: {
    select: {
      id: true,
      name: true,
      avatar: true,
      role: true,
      _count: {
        select: { patch_resource: true }
      }
    }
  },
  links: {
    orderBy: { sort_order: 'asc' }
  },
  _count: {
    select: { like_by: true }
  }
} satisfies Prisma.patch_resourceInclude

type PatchResourcePayload = Prisma.patch_resourceGetPayload<{
  include: typeof resourceInclude
}>

// 不渲染 noteHtml: 列表卡片不展示备注, 只有详情页 (detail.ts) 需要;
// note 原文须保留, 编辑弹窗用它预填表单
export const mapResource = (
  resource: PatchResourcePayload,
  isLike: boolean
): PatchResource => ({
  id: resource.id,
  name: resource.name,
  section: resource.section,
  uniqueId: resource.patch.unique_id,
  type: resource.type,
  language: resource.language,
  note: resource.note,
  platform: resource.platform,
  emulatorType: resource.emulator_type,
  modelName: resource.model_name,
  download: resource.download,
  links: resource.links.map((link) => ({
    id: link.id,
    storage: link.storage,
    size: link.size,
    code: link.code,
    password: link.password,
    hash: link.hash,
    content: link.content,
    sortOrder: link.sort_order,
    download: link.download
  })),
  likeCount: resource._count.like_by,
  isLike,
  status: resource.status,
  userId: resource.user_id,
  patchId: resource.patch_id,
  created: String(resource.created),
  user: {
    id: resource.user.id,
    name: resource.user.name,
    avatar: resource.user.avatar,
    patchCount: resource.user._count.patch_resource,
    role: resource.user.role
  }
})

// 资源 tab 列表查询 (详情页 findFirst 仍用 resourceInclude, 按 id 可自行下推)。
// patch_id 过滤对返回行恒真, 勿删: 无外层条件时 Prisma 把 _count 编译成点赞表
// 整表 GROUP BY, 有它 (配合 resource_id 索引) 才下推成按本 patch 聚合
const listInclude = (patchId: number) =>
  ({
    ...resourceInclude,
    _count: {
      select: { like_by: { where: { resource: { patch_id: patchId } } } }
    }
  }) satisfies Prisma.patch_resourceInclude

// 按发布时间从新到旧; 迁移数据同一 patch 内 created 有并列, id 兜底保证顺序确定
const listOrderBy = [
  { created: 'desc' },
  { id: 'desc' }
] satisfies Prisma.patch_resourceOrderByWithRelationInput[]

// 公开视角查询: 恒按 status=0, 不含 viewer 私有点赞态, 结果可跨 viewer 共享缓存
const queryPublicResources = async (
  patchId: number
): Promise<PatchResource[]> => {
  const data = await prisma.patch_resource.findMany({
    where: { patch_id: patchId, status: 0 },
    include: listInclude(patchId),
    orderBy: listOrderBy
  })
  return data.map((resource) => mapResource(resource, false))
}

// 为登录用户在公开列表上叠加个人点赞态 (单次 in 查询, 匿名跳过)
const applyIsLike = async (
  resources: PatchResource[],
  uid: number
): Promise<PatchResource[]> => {
  if (!uid || resources.length === 0) {
    return resources
  }
  const liked = await prisma.user_patch_resource_like_relation.findMany({
    where: {
      user_id: uid,
      resource_id: { in: resources.map((resource) => resource.id) }
    },
    select: { resource_id: true }
  })
  const likedIds = new Set(liked.map((relation) => relation.resource_id))
  return resources.map((resource) => ({
    ...resource,
    isLike: likedIds.has(resource.id)
  }))
}

export const getPatchResource = async (
  input: z.infer<typeof patchIdSchema>,
  viewer: KunViewer | null
): Promise<PatchResource[]> => {
  const { patchId } = input
  const uid = viewer?.uid ?? 0

  // 可见集不同于公开集的 viewer (role>=3 / 持有待审核资源的作者) 不走共享缓存
  if (await shouldBypassSharedCache(viewer)) {
    const data = await prisma.patch_resource.findMany({
      where: { patch_id: patchId, ...getResourceVisibilityWhere(viewer) },
      include: {
        ...listInclude(patchId),
        like_by: { where: { user_id: uid } }
      },
      orderBy: listOrderBy
    })
    return data.map((resource) =>
      mapResource(resource, resource.like_by.length > 0)
    )
  }

  const cacheKey = await getPatchResourceDetailCacheKey(patchId)
  const cached = await getCachedPatchResourceDetail(cacheKey)
  if (cached.response) {
    return applyIsLike(cached.response, uid)
  }

  // 版本号读取失败 (cacheKey 为 null) 与缓存读失败均不参与单飞
  if (!cacheKey || !cached.canWrite) {
    return applyIsLike(await queryPublicResources(patchId), uid)
  }

  const publicResources = await kunCacheSingleflight({
    cacheKey,
    readCache: () => getCachedPatchResourceDetail(cacheKey),
    writeCache: (response) => setPatchResourceDetailCache(cacheKey, response),
    writeCacheIfAbsent: (response) =>
      setPatchResourceDetailCacheIfAbsent(cacheKey, response),
    query: () => queryPublicResources(patchId)
  })
  return applyIsLike(publicResources, uid)
}
