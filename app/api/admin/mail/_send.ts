import crypto from 'crypto'
import { setKv } from '~/lib/redis'
import {
  kunUnsubscribePageUrl,
  renderCampaignEmail
} from '~/constants/email/campaign'
import { sendKunEmail } from '~/app/api/utils/sendKunEmail'
import type {
  CampaignSlots,
  CampaignTemplateId
} from '~/constants/email/campaign'

const CACHE_KEY = 'auth:mail:notice'

export const sendEmailHTML = async (
  templateId: CampaignTemplateId,
  slots: CampaignSlots,
  email: string
) => {
  const validateEmailCode = crypto.randomUUID()

  await setKv(`${CACHE_KEY}:${email}`, validateEmailCode, 7 * 24 * 60 * 60)

  // 参数经 URLSearchParams 编码: 邮箱里的 + 手拼进查询串会被落地页读成空格
  const unsubscribeUrl = new URL(kunUnsubscribePageUrl())
  unsubscribeUrl.searchParams.set('email', email)
  unsubscribeUrl.searchParams.set('code', validateEmailCode)

  const { subject, html } = renderCampaignEmail(
    templateId,
    slots,
    unsubscribeUrl.toString()
  )

  return sendKunEmail({
    to: [email],
    subject,
    tag: templateId,
    html_body: html,
    plain_body: '请在支持 HTML 的邮件客户端中查看此邮件'
  })
}
