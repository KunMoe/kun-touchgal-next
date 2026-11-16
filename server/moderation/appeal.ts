import { prisma } from '~/prisma/index'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { AppealContentType } from '~/constants/appeal'
import type { AppealLink } from '~/types/api/appeal'

type ModerationClient = Prisma.TransactionClient | typeof prisma

// 申诉页与管理端展示资源链接时读取的列, 与 AppealLink 的键一一对应
export const APPEAL_LINK_SELECT = {
  id: true,
  storage: true,
  content: true,
  size: true,
  code: true,
  password: true
} satisfies Record<keyof AppealLink, true>

// 模型型号只属于 AI 翻译补丁 (其余类型落库恒为空串), 所以只在这类资源的申诉里出现;
// 不适用时返回 undefined, 申诉内容里不带这一项
export const getAppealModelName = (resource: {
  type: string[]
  model_name: string
}) => (resource.type.includes('ai') ? resource.model_name : undefined)

// 删除内容时清理尚未处理的申诉, 已 approved/rejected 的申诉保留作历史记录
export const deletePendingAppeals = async (
  contentType: AppealContentType,
  contentId: number | number[],
  db: ModerationClient = prisma
) =>
  db.moderation_appeal.deleteMany({
    where: {
      content_type: contentType,
      content_id: Array.isArray(contentId) ? { in: contentId } : contentId,
      status: 'pending'
    }
  })
