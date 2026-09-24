import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { delKv, setKvIfAbsent } from '~/lib/redis'
import { DOWNLOAD_DEDUP_CACHE_DURATION } from '~/config/cache'
import { updatePatchResourceStatsSchema } from '~/validations/patch'
import { invalidateResourceStatsListCache } from '~/app/api/resource/cache'

const downloadStats = async (
  input: z.infer<typeof updatePatchResourceStatsSchema>,
  dedupKey: string
) => {
  const counted = await prisma.$transaction(async (tx) => {
    // 校验 link → resource → patch 是完整的一条链, 杜绝用任意三元组交叉刷计数
    const link = await tx.patch_resource_link.findUnique({
      where: { id: input.linkId },
      select: {
        resource_id: true,
        resource: { select: { patch_id: true } }
      }
    })
    if (
      !link ||
      link.resource_id !== input.resourceId ||
      link.resource.patch_id !== input.patchId
    ) {
      return false
    }

    await tx.patch.update({
      where: { id: input.patchId },
      data: { download: { increment: 1 } }
    })

    await tx.patch_resource.update({
      where: { id: input.resourceId },
      data: { download: { increment: 1 } }
    })

    await tx.patch_resource_link.update({
      where: { id: input.linkId },
      data: { download: { increment: 1 } }
    })
    return true
  })

  if (!counted) {
    // 三元组不成立: 释放去重槽, 避免毒化该 (身份, 链接) 后续的合法计数
    await delKv(dedupKey)
    return '资源不存在'
  }

  await invalidateResourceStatsListCache()
  // 刻意不失效资源详情缓存: 缓存内嵌的 download 计数无 UI 消费方 (卡片只渲染
  // likeCount, 列表按 sort_order 排序), 而下载是该缓存最高频的写路径, 失效会
  // 白白压低命中率; 将来卡片若渲染 download, 须恢复
  // invalidatePatchResourceDetailCache(input.patchId)
  return {}
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, updatePatchResourceStatsSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  // 匿名可计数: 已登录用 uid, 否则回退到 IP; 二者命名空间隔离防碰撞
  const payload = await verifyHeaderCookie(req)
  const identity = payload?.uid
    ? `u:${payload.uid}`
    : `ip:${getRemoteIp(req.headers) || 'unknown'}`
  const dedupKey = `download:dedup:${identity}:${input.linkId}`

  const fresh = await setKvIfAbsent(
    dedupKey,
    '1',
    DOWNLOAD_DEDUP_CACHE_DURATION
  )
  if (!fresh) {
    // 窗口内重复请求: 直接成功返回, 不查库、不自增、不失效缓存
    return NextResponse.json({})
  }

  const response = await downloadStats(input, dedupKey)
  return NextResponse.json(response)
}
