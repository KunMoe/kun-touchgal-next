import { RESOURCE_STATUS } from '~/constants/contentStatus'
import type { Prisma } from '~/prisma/generated/prisma/client'

// 资源编辑被审核拦截时把资源转为待审核, 等裁决落定。
// 资源编辑的主体 (S3 重绑、链接 diff、聚合重算、出箱与缓存失效) 在
// app/api/patch/resource/update.ts; 那里已在行锁下按守卫复检过状态, 这里只承载
// status 这一处写入 —— 内容表的 status 只在 server/content 里写
export const markResourcePendingReview = (
  tx: Prisma.TransactionClient,
  resourceId: number
) =>
  tx.patch_resource.update({
    where: { id: resourceId },
    data: { status: RESOURCE_STATUS.pending },
    select: { status: true }
  })
