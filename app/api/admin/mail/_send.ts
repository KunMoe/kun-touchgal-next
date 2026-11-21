import { renderCampaignEmail } from '~/constants/email/campaign'
import { sendKunEmail } from '~/app/api/utils/sendKunEmail'
import { createUnsubscribeUrl } from '~/server/mail/unsubscribeToken'
import type {
  CampaignSlots,
  CampaignTemplateId
} from '~/constants/email/campaign'

export const sendEmailHTML = async (
  templateId: CampaignTemplateId,
  slots: CampaignSlots,
  recipient: { id: number; email: string }
) => {
  const { subject, html } = renderCampaignEmail(
    templateId,
    slots,
    createUnsubscribeUrl(recipient.id)
  )

  return sendKunEmail({
    to: [recipient.email],
    subject,
    tag: templateId,
    html_body: html,
    plain_body: '请在支持 HTML 的邮件客户端中查看此邮件'
  })
}
