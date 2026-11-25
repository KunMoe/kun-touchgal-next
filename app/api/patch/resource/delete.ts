import * as z from 'zod'
import { kunId } from '~/validations/primitives'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import {
  executeResourceRemoval,
  planResourceRemoval
} from '~/server/content/resource/remove'
import type { KunActor } from '~/constants/role'
import {
  contentGuard,
  contentSkipMessage,
  decideContentAction
} from '~/utils/content/policy'

const resourceIdSchema = z.object({
  resourceId: kunId('资源 ID')
})

export const deleteResource = async (
  input: z.infer<typeof resourceIdSchema>,
  actor: KunActor
) => {
  // 事务外预检仅做权限与状态的快速失败; 链接不从这里取 —— 快照与事务之间的并发重绑
  // 会换 s3_key, 入队的事实源是命令在行锁下重读的集合
  const decision = decideContentAction(
    'resource',
    await prisma.patch_resource.findUnique({
      where: { id: input.resourceId },
      select: { id: true, user_id: true, status: true }
    }),
    actor,
    'delete'
  )
  if (!decision.ok) {
    return decision.message
  }
  const patchResource = decision.row

  // 上面判的是事务外快照。同一组条件交给命令在行锁下再判一次: 其间被管理员隐藏或
  // 被送审的资源不会被作者物理删除
  const guard = contentGuard('resource', actor)

  const failure = await kunTx('resource.delete', async (ctx) => {
    // 前台删除收回发布时给作者的奖励; 其余删除入口都不收回
    const plan = await planResourceRemoval(ctx, [patchResource.id], {
      guard,
      refundPublishReward: true
    })
    const [skipped] = plan.skipped
    if (skipped) {
      ctx.fail(contentSkipMessage('resource', 'delete', skipped))
    }
    await executeResourceRemoval(ctx, plan)
  })
  return failure ?? {}
}
