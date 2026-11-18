import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { adminBatchHandleReportSchema } from '~/validations/admin'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { handleReport } from '~/app/api/admin/report/handle/service'
import { can } from '~/constants/permission'

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, adminBatchHandleReportSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

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
        payload.uid
      )
      if (typeof res === 'string') {
        skipped += 1
      } else {
        success += 1
      }
    } catch (error) {
      console.error(
        'Batch report handle failed:',
        input.action,
        reportId,
        error
      )
      failedIds.push(reportId)
    }
  }

  return NextResponse.json({ success, skipped, failedIds })
}
