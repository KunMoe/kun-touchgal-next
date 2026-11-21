import { kunMoyuMoe } from '~/config/moyu-moe'
import { escapeHtml } from '~/utils/escapeHtml'
import { touchgalTemplate } from './templates/touchgal'
import { announcementTemplate } from './templates/announcement'

// 群发邮件的模板。标题与正文是超级管理员写的受信 HTML, 原样进邮件 (字段名里的 Html 说的
// 就是这件事), 不做任何占位符替换: 正文里写的 {{email}}、$& 都只是普通文字。
// 每个收件人不同的只有退订链接, 由调用方用 URL / URLSearchParams 构造, 这里放进 href 之前
// 做属性转义。后台的预览与实际发出的邮件是同一个 renderCampaignEmail 的输出
export interface CampaignSlots {
  titleHtml: string
  contentHtml: string
}

// 模板函数拿到的槽位: unsubscribeHref 已经转义, 可以直接放进带引号的 href
export interface CampaignTemplateSlots extends CampaignSlots {
  unsubscribeHref: string
}

export const CAMPAIGN_TEMPLATES = {
  touchgal: {
    name: `${kunMoyuMoe.titleShort} 全体消息`,
    render: touchgalTemplate
  },
  announcement: {
    name: `${kunMoyuMoe.titleShort} 重要公告`,
    render: announcementTemplate
  }
} as const

export type CampaignTemplateId = keyof typeof CAMPAIGN_TEMPLATES

// 给 z.enum 用的非空元组
export const CAMPAIGN_TEMPLATE_IDS = Object.keys(CAMPAIGN_TEMPLATES) as [
  CampaignTemplateId,
  ...CampaignTemplateId[]
]

// 退订落地页。发信时在它后面带上收件人的参数; 预览里没有收件人, 用它本身占位
export const kunUnsubscribePageUrl = () =>
  `${
    process.env.NODE_ENV === 'development'
      ? process.env.NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV
      : process.env.NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD
  }/auth/email-notice`

export const renderCampaignEmail = (
  id: CampaignTemplateId,
  slots: CampaignSlots,
  unsubscribeUrl: string
): { subject: string; html: string } => {
  const template = CAMPAIGN_TEMPLATES[id]
  return {
    subject: `${kunMoyuMoe.titleShort} - ${template.name}`,
    html: template.render({
      ...slots,
      unsubscribeHref: escapeHtml(unsubscribeUrl)
    })
  }
}

export const isCampaignTemplateId = (id: string): id is CampaignTemplateId =>
  Object.hasOwn(CAMPAIGN_TEMPLATES, id)
