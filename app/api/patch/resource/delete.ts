import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { RESOURCE_STATUS } from '~/constants/contentStatus'
import { can } from '~/constants/permission'
import {
  executeResourceRemoval,
  planResourceRemoval
} from '~/server/content/resource/remove'
import type { ResourceRemovalGuard } from '~/server/content/resource/remove'
import type { KunActor } from '~/constants/role'

const resourceIdSchema = z.object({
  resourceId: z.coerce
    .number({ message: '资源 ID 必须为数字' })
    .min(1)
    .max(9999999)
})

export const deleteResource = async (
  input: z.infer<typeof resourceIdSchema>,
  actor: KunActor
) => {
  const { uid } = actor
  const canModerate = can(actor, 'content.moderateAny')
  // 事务外预检仅做权限与状态的快速失败; 链接不从这里取 —— 快照与事务之间的并发重绑
  // 会换 s3_key, 入队的事实源是命令在行锁下重读的集合
  const patchResource = await prisma.patch_resource.findUnique({
    where: { id: input.resourceId },
    select: { id: true, user_id: true, status: true }
  })
  // 隐藏 (status=1) 的资源仅后台可管理, 前端与不存在等同
  if (!patchResource || patchResource.status === 1) {
    return '未找到对应的资源'
  }

  if (patchResource.user_id !== uid && !canModerate) {
    return '您没有权限删除该资源'
  }
  // 待初次审核 (status=2) / 待审核 (status=3) 的资源禁止作者删除; 管理员可删
  if (!canModerate && patchResource.status !== 0) {
    return '该资源正在审核中, 暂时无法删除'
  }

  // 上面判的是事务外快照。同一组条件交给命令在行锁下再判一次: 其间被管理员隐藏或
  // 被送审的资源不会被作者物理删除
  const guard: ResourceRemovalGuard = !canModerate
    ? { statusIn: [RESOURCE_STATUS.public], ownerUid: uid }
    : {
        statusIn: [
          RESOURCE_STATUS.public,
          RESOURCE_STATUS.awaitingApproval,
          RESOURCE_STATUS.pending
        ]
      }

  const failure = await kunTx('resource.delete', async (ctx) => {
    // 前台删除收回发布时给作者的奖励; 其余删除入口都不收回
    const plan = await planResourceRemoval(ctx, [patchResource.id], {
      guard,
      refundPublishReward: true
    })
    const [skipped] = plan.skipped
    if (skipped) {
      ctx.fail(
        skipped.reason === 'owner'
          ? '您没有权限删除该资源'
          : skipped.reason === 'status' &&
              skipped.status !== RESOURCE_STATUS.hidden
            ? '该资源正在审核中, 暂时无法删除'
            : '未找到对应的资源'
      )
    }
    await executeResourceRemoval(ctx, plan)
  })
  return failure ?? {}
}
