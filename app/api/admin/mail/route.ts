import { kunRoute } from '~/app/api/utils/kunRoute'
import { MAIL_CAMPAIGN_LIST_SIZE } from '~/constants/admin'
import {
  createCampaign,
  listCampaigns,
  transitionCampaign
} from '~/server/mail/campaign'
import {
  adminMailCampaignActionSchema,
  adminSendEmailSchema
} from '~/validations/admin'

// 群发邮件: 这里只建任务、看进度、取消或继续; 发信在定时任务进程里
// (server/mail/campaign.ts)

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  handler: () => listCampaigns(MAIL_CAMPAIGN_LIST_SIZE)
})

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'admin.access',
  input: adminSendEmailSchema,
  handler: ({ input, actor }) =>
    createCampaign(
      {
        templateId: input.templateId,
        title: input.variables.title,
        contentHtml: input.variables.content
      },
      actor
    )
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminMailCampaignActionSchema,
  handler: ({ input, actor }) =>
    transitionCampaign(input.campaignId, input.action, actor)
})
