import { kunRoute } from '~/app/api/utils/kunRoute'
import { kunLog } from '~/lib/log.server'
import { adminBatchHandleReportSchema } from '~/validations/admin'
import { handleReport } from '~/app/api/admin/report/handle/service'

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'admin.access',
  input: adminBatchHandleReportSchema,
  handler: async ({ input, actor }) => {
    const reportIds = [...new Set(input.reportIds)]
    let success = 0
    let skipped = 0
    const failedIds: number[] = []

    // 逐条处理, 但客户端只提交一个网络往返. 处理某条举报会连带处理同一目标的
    // 其他待处理举报, 同批后续举报命中「已被处理/不存在」属预期, 计入 skipped
    // 而非失败; 单条异常只计入 failedIds, 不影响同批其余举报
    for (const reportId of reportIds) {
      try {
        const res = await handleReport(
          { reportId, action: input.action, content: input.content },
          actor.uid
        )
        if (typeof res === 'string') {
          skipped += 1
        } else {
          success += 1
        }
      } catch (error) {
        kunLog(
          'admin.batch_item_failed',
          { kind: 'report', action: input.action, id: reportId },
          error
        )
        failedIds.push(reportId)
      }
    }

    return { success, skipped, failedIds }
  }
})
