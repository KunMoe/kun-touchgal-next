import * as z from 'zod'
import { prisma } from '~/prisma/index'
import type { Prisma } from '~/prisma/generated/prisma/client'
import { sanitizeResourceLinksForAuditLog } from '~/app/api/patch/resource/_helper'
import { kunTx } from '~/server/db/tx'
import {
  executeResourceRemoval,
  planResourceRemoval
} from '~/server/content/resource/remove'
import { truncateLogContent } from '~/app/api/admin/_log'
import { adminDeleteResourceSchema } from '~/validations/admin'

const adminDeleteResourceSummaryLimit = 10

type DeletedResource = Prisma.patch_resourceGetPayload<{
  include: { patch: { select: { name: true } }; links: true }
}>

const buildDeleteLogContent = (
  adminName: string,
  resources: DeletedResource[]
) => {
  // 单条保持原有全量快照格式, 审计信息不退化
  if (resources.length === 1) {
    const [resource] = resources
    const sanitizedResource = {
      ...resource,
      links: sanitizeResourceLinksForAuditLog(resource.links)
    }
    // note 上限即 10007, 不截断会 22001 回滚整个删除事务
    return truncateLogContent(
      `管理员 ${adminName} 删除了一个资源\n\nGalgame 名:\n${resource.patch.name}\n\n资源信息:\n${JSON.stringify(sanitizedResource)}`
    )
  }

  // 批量: 全量 JSON 必然超 note 上限被整体截断, 改记全部 id + 前 N 条摘要
  const summaries = resources
    .slice(0, adminDeleteResourceSummaryLimit)
    .map((resource) => ({
      id: resource.id,
      name: resource.name,
      patchName: resource.patch.name,
      userId: resource.user_id,
      section: resource.section,
      status: resource.status,
      linkCount: resource.links.length
    }))
  const suffix =
    resources.length > summaries.length
      ? `\n其余 ${resources.length - summaries.length} 条资源摘要已省略`
      : ''

  return truncateLogContent(
    `管理员 ${adminName} 批量删除了 ${resources.length} 条资源\n资源 ID: ${resources
      .map((resource) => resource.id)
      .join(', ')}\n资源摘要: ${JSON.stringify(summaries)}${suffix}`
  )
}

export const deleteResource = async (
  input: z.infer<typeof adminDeleteResourceSchema>,
  uid: number,
  // 后台删除收回作者的发布奖励; 删号的清除器不收回 (清除器调用的服务都不碰 user 行,
  // 见 server/account/deleteAccount.ts)。没有默认值: 每个调用方都要表态
  options: { refundPublishReward: boolean }
) => {
  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  // 后台删除不设守卫 (隐藏、待审的资源都能删)。与批量隐藏等入口在行锁上互等时数据库会判
  // 死锁回滚其中一方, 事务整体回滚、无副作用, 重放即可
  return kunTx(
    'admin.resource.delete',
    async (ctx) => {
      const plan = await planResourceRemoval(ctx, input.resourceIds, {
        refundPublishReward: options.refundPublishReward
      })
      if (!plan.rows.length) {
        ctx.fail('未找到对应的资源')
      }
      // 审计日志要补丁名; 资源行与链接用命令在行锁下重读到的, 即删除瞬间的状态
      const patches = await ctx.tx.patch.findMany({
        where: {
          id: { in: [...new Set(plan.rows.map((row) => row.patch_id))] }
        },
        select: { id: true, name: true }
      })
      const patchNameById = new Map(
        patches.map((patch) => [patch.id, patch.name])
      )

      await executeResourceRemoval(ctx, plan)

      await ctx.tx.admin_log.create({
        data: {
          type: 'delete',
          user_id: uid,
          content: buildDeleteLogContent(
            admin.name,
            plan.rows.map((row) => ({
              ...row,
              patch: { name: patchNameById.get(row.patch_id) ?? '' }
            }))
          )
        }
      })

      return { count: plan.rows.length }
    },
    // 批量上限 100 条且持锁期间还要跑评论派生清理, 默认 5s 交互事务超时余量不足
    { retry: 2, timeout: 60000 }
  )
}
