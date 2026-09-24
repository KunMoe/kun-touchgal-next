import { NextResponse } from 'next/server'
import * as z from 'zod'
import { prisma } from '~/prisma'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { queueSearchSync } from '~/server/search/sync'
import type { NextRequest } from 'next/server'

// 关联变更后的缓存失效: 列表缓存 + 补丁详情缓存。后者会抛 (cache.ts 内 re-throw),
// 前者内部吞错永不 reject, 故只有后者包 try。company/fetch 路由主流程是外部抓取
// 语义, 套不进 createPatchRelationHandler, 但共用这段失效。
// 搜索同步刻意不并入: 两类调用点语义不同 (见 createPatchRelationHandler 内注释)
export const invalidatePatchRelationCaches = async (
  uniqueId: string,
  invalidateListCache: () => Promise<void>
) => {
  await invalidateListCache()
  try {
    await invalidatePatchContentCache(uniqueId)
  } catch {
    // 缓存失效失败不影响关联更新结果
  }
}

// tag / company 各自 POST(增) 与 PUT(删) 共四个 handler 的公共编排:
// 解析 -> 管理员门 -> 补丁存在性 -> 变更事务 -> 失效。
// mutate 返回关系是否真的发生变化, 无变化则一处缓存都不动
export const createPatchRelationHandler = <
  T extends z.ZodType<{ patchId: number }>
>(options: {
  schema: T
  parseBody: (req: NextRequest, schema: T) => Promise<z.infer<T> | string>
  mutate: (input: z.infer<T>) => Promise<boolean>
  invalidateListCache: () => Promise<void>
}) => {
  return async (req: NextRequest) => {
    const input = await options.parseBody(req, options.schema)
    if (typeof input === 'string') {
      return NextResponse.json(input)
    }
    const { patchId } = input

    const payload = await verifyHeaderCookie(req)
    if (!payload) {
      return NextResponse.json('用户未登录')
    }
    if (payload.role < 3) {
      return NextResponse.json('本页面仅管理员可访问')
    }

    const patch = await prisma.patch.findUnique({
      where: { id: patchId },
      select: { unique_id: true }
    })
    if (!patch) {
      return NextResponse.json('未找到 Galgame')
    }

    const changed = await options.mutate(input)
    if (changed) {
      await invalidatePatchRelationCaches(
        patch.unique_id,
        options.invalidateListCache
      )
      // mutate 已在事务内 enqueueSearchOutbox, 按 sync.ts 的分工这里本应只
      // kickSearchOutboxDrain; 沿用既有 queueSearchSync 是 L17 的一部分
      // (docs/code-quality-audit.md 已立案, 全仓 10 处待统一)。fetch 路由那边
      // 未入队、必须 queueSearchSync, 故这一步留在调用点而非失效函数里
      queueSearchSync(patchId)
    }
    return NextResponse.json({})
  }
}
