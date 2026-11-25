import { prisma } from '~/prisma/index'
import type { KunTx } from '~/prisma/index'
import type { AdminReportTargetType } from '~/types/api/admin'

type ReportClient = KunTx

// 删除评论/评分时清理其尚未处理的举报, 已处理的举报保留作历史记录。
// patch_report.comment_id / rating_id 是 ON DELETE SET NULL; 删除前清理
// 会持有举报行锁再等内容行锁, 与级联 SET NULL 的「内容行→举报行」锁序
// 相反, 可与并发的举报处理死锁 —— 故在删除之后清理: 级联置空对本事务
// 可见, 目标 id 为 NULL 且 status 仍为 0 的行即为孤儿 (含删除期间并发
// 新增的举报与历史遗留)。创建路径必填目标 id, 故 NULL 只可能来自级联,
// 按 NULL 目标清理零误伤; status: 0 防误删已被并发处理的历史记录
export const deleteOrphanReports = async (
  targetType: AdminReportTargetType,
  db: ReportClient = prisma
) => {
  await db.patch_report.deleteMany({
    where: {
      target_type: targetType,
      status: 0,
      ...(targetType === 'comment' ? { comment_id: null } : { rating_id: null })
    }
  })
}
