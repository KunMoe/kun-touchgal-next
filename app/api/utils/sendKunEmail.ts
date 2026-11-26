import { kunLog } from '~/lib/log.server'

export const SEND_EMAIL_TIMEOUT_MS = 15 * 1000
const SEND_EMAIL_ERROR = '邮件发送失败, 请稍后重试'

interface KunEmailPayload {
  to: string[]
  subject: string
  tag: string
  html_body: string
  plain_body: string
}

export const sendKunEmail = async (payload: KunEmailPayload) => {
  try {
    const res = await fetch(
      `${process.env.KUN_VISUAL_NOVEL_EMAIL_HOST}/api/v1/send/message`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Server-API-Key': process.env.KUN_VISUAL_NOVEL_EMAIL_PASSWORD || '',
          Authorization: `Bearer ${process.env.KUN_VISUAL_NOVEL_EMAIL_PASSWORD}`
        },
        body: JSON.stringify({
          from: process.env.KUN_VISUAL_NOVEL_EMAIL_ACCOUNT,
          sender: `${process.env.KUN_VISUAL_NOVEL_EMAIL_FROM}<${process.env.KUN_VISUAL_NOVEL_EMAIL_ACCOUNT}>`,
          ...payload
        }),
        signal: AbortSignal.timeout(SEND_EMAIL_TIMEOUT_MS)
      }
    )

    if (!res.ok) {
      // 中继的原始响应体不写进日志 (可能带收件地址), 只释放掉
      await res.body?.cancel()
      kunLog('email.send_failed', { tag: payload.tag, status: res.status })
      return SEND_EMAIL_ERROR
    }

    const r = await res.json()
    if (r.status === 'error') {
      // 只记中继的错误码 (如 Postal 的 NoRecipients), 不记 message
      kunLog('email.send_failed', {
        tag: payload.tag,
        relayStatus: 'error',
        relayCode: typeof r.data?.code === 'string' ? r.data.code : undefined
      })
      return SEND_EMAIL_ERROR
    }
  } catch (error) {
    kunLog('email.send_failed', { tag: payload.tag }, error)
    return SEND_EMAIL_ERROR
  }
}
