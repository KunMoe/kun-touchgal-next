import { prisma } from '~/prisma/index'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type {
  ModerationContentType,
  ModerationTextType
} from '~/constants/moderation'
import { getModerationConfig } from './config'
import { isSubjectEmpty, subjectChanged } from './subject'
import type { ModerationSubject } from './subject'
import { encodeModerationPayload } from './taskCodec'
import type { ModerationTaskBody, TextTaskExtras } from './taskCodec'

type ModerationClient = Prisma.TransactionClient | typeof prisma

export interface ModerationPreScreen {
  // create a moderation task for the worker
  queue: boolean
  // content starts pending (待审核) until the verdict lands
  intercept: boolean
  dryRun: boolean
}

// 字面量类型是有意的: ModerationPlan 靠 queue 的 false / true 判别是否带主体
export const MODERATION_SKIP = {
  queue: false,
  intercept: false,
  dryRun: false
} as const satisfies ModerationPreScreen

// 两段式入口的第一段产物。排队时带着同一份主体进入第二段 (enqueueTextModeration),
// 调用点不再重复传文本
export type QueuedModerationPlan<T extends ModerationTextType> = {
  queue: true
  intercept: boolean
  dryRun: boolean
  subject: ModerationSubject<T>
}

export type ModerationPlan<T extends ModerationTextType> =
  typeof MODERATION_SKIP | QueuedModerationPlan<T>

// 第一段: 在事务外、任何不可回滚的副作用 (如 S3 绑定) 之前调用 —— 读审核配置可能因
// Redis 故障抛错; 写内容行时又需要先知道 intercept。
// 仅超级管理员 (role>=4) 豁免送审, 与审核后台的权限门槛一致; 豁免集中在此处并靠必传的
// userRole 强制携带角色, 防止新增调用点漏加检查 (资源 create 路径曾因此漏过豁免)。
// previous 是编辑前的主体: 送审字段没有变化就不重审。能在本地判定的都排在读配置之前
export const planTextModeration = async <T extends ModerationTextType>(
  subject: ModerationSubject<T>,
  options: { userRole: number; previous?: ModerationSubject<T> }
): Promise<ModerationPlan<T>> => {
  if (options.userRole >= 4) {
    return MODERATION_SKIP
  }
  if (options.previous && !subjectChanged(options.previous, subject)) {
    return MODERATION_SKIP
  }
  if (isSubjectEmpty(subject)) {
    return MODERATION_SKIP
  }
  const config = await getModerationConfig()
  if (!config.enabled) {
    return MODERATION_SKIP
  }
  return {
    queue: true,
    intercept: !config.dryRun,
    dryRun: config.dryRun,
    subject
  }
}

export const preScreenMedia = async (
  userRole: number
): Promise<ModerationPreScreen> => {
  if (userRole >= 4) {
    return MODERATION_SKIP
  }
  const config = await getModerationConfig()
  if (!config.enabled) {
    return MODERATION_SKIP
  }
  return { queue: true, intercept: !config.dryRun, dryRun: config.dryRun }
}

// 内容存在未裁决的审核任务 (AI 审核中或等待人工) 时禁止作者再次修改,
// 否则编辑会使送审快照与实际内容脱节, 也可绕过尚未落地的人工裁决;
// dry_run 任务不拦截内容, 不构成修改限制
export const hasPendingModeration = async (
  contentType: ModerationContentType,
  target: { contentId: number } | { userId: number }
) => {
  const count = await prisma.moderation_task.count({
    where: {
      content_type: contentType,
      status: { in: ['pending', 'manual'] },
      dry_run: false,
      ...('contentId' in target
        ? { content_id: target.contentId }
        : { user_id: target.userId })
    }
  })
  return count > 0
}

// 删除内容时清理尚未有最终裁决的任务 (pending / 失败转人工),
// 已 approved/rejected 的任务保留作历史记录.
// excludeDryRun: 内容仍存在 (管理员改 status) 时置 true —— dry_run 任务在 apply
// 中 claim 后即返回、永不改动内容, 无需作废, 保留其评估数据
export const deletePendingModerationTasks = async (
  contentType: ModerationContentType,
  contentId: number | number[],
  db: ModerationClient = prisma,
  excludeDryRun = false
) =>
  db.moderation_task.deleteMany({
    where: {
      content_type: contentType,
      content_id: Array.isArray(contentId) ? { in: contentId } : contentId,
      status: { in: ['pending', 'manual'] },
      ...(excludeDryRun ? { dry_run: false } : {})
    }
  })

interface ModerationTaskTarget {
  contentId?: number
  patchId?: number
  userId: number
  dryRun: boolean
}

export const createModerationTask = async (
  input: ModerationTaskBody & ModerationTaskTarget,
  db: ModerationClient = prisma
) => {
  // an edit supersedes any verdict still in flight for the same content,
  // otherwise an older approval could land after this newer submission
  await db.moderation_task.updateMany({
    where: {
      content_type: input.contentType,
      status: 'pending',
      ...(input.contentId
        ? { content_id: input.contentId }
        : { user_id: input.userId })
    },
    data: { status: 'superseded' }
  })

  return db.moderation_task.create({
    data: {
      content_type: input.contentType,
      content_id: input.contentId ?? null,
      patch_id: input.patchId ?? null,
      user_id: input.userId,
      payload: encodeModerationPayload(input) as Prisma.InputJsonValue,
      dry_run: input.dryRun
    }
  })
}

// 第二段: 在事务内拿到内容行 id 之后调用。content_type 与送审内容都取自 plan
export const enqueueTextModeration = async <T extends ModerationTextType>(
  db: ModerationClient,
  plan: QueuedModerationPlan<T>,
  target: Omit<ModerationTaskTarget, 'dryRun'> & TextTaskExtras[T]
) =>
  createModerationTask(
    // T 与 TextTaskExtras[T] 的对应由本函数签名保证, 泛型下联合类型推不出这层关联
    {
      contentType: plan.subject.contentType,
      subject: plan.subject,
      ...target,
      dryRun: plan.dryRun
    } as ModerationTaskBody & ModerationTaskTarget,
    db
  )
