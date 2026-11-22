import { prisma } from '~/prisma/index'
import type { Prisma } from '~/prisma/generated/prisma/client'
import { MODERATION_MAX_PENDING_PER_USER } from '~/constants/moderation'
import type {
  ModerationContentType,
  ModerationTextType
} from '~/constants/moderation'
import { can } from '~/constants/permission'
import { getModerationConfig } from './config'
import { isSubjectEmpty, subjectChanged } from './subject'
import type { ModerationSubject } from './subject'
import { encodeModerationPayload } from './taskCodec'
import type { ModerationTaskBody, TextTaskExtras } from './taskCodec'
import type { KunActor } from '~/constants/role'

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
// 仅有 moderation.skip 能力的操作者 (超级管理员) 豁免送审, 与审核后台的权限门槛一致;
// 豁免集中在此处并靠必传的 actor 强制携带操作者, 防止新增调用点漏加检查 (资源 create
// 路径曾因此漏过豁免)。actor 只能由会话构造, 调用点写不出字面量角色 (后台资源编辑曾以
// 字面量 3 调用, 超级管理员因此被送审)。
// previous 是编辑前的主体: 送审字段没有变化就不重审。能在本地判定的都排在读配置之前。
// 返回 string 即提交者在途的任务已到上限 (见 pendingLimitError), 调用点原样返回给用户
export const planTextModeration = async <T extends ModerationTextType>(
  subject: ModerationSubject<T>,
  options: { actor: KunActor; previous?: ModerationSubject<T> }
): Promise<ModerationPlan<T> | string> => {
  if (can(options.actor, 'moderation.skip')) {
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
  const limitError = await pendingLimitError(options.actor)
  if (limitError) {
    return limitError
  }
  return {
    queue: true,
    intercept: !config.dryRun,
    dryRun: config.dryRun,
    subject
  }
}

export const preScreenMedia = async (
  actor: KunActor
): Promise<ModerationPreScreen | string> => {
  if (can(actor, 'moderation.skip')) {
    return MODERATION_SKIP
  }
  const config = await getModerationConfig()
  if (!config.enabled) {
    return MODERATION_SKIP
  }
  const limitError = await pendingLimitError(actor)
  if (limitError) {
    return limitError
  }
  return { queue: true, intercept: !config.dryRun, dryRun: config.dryRun }
}

// 按提交者限在途任务数 (MODERATION_MAX_PENDING_PER_USER 有为什么限数量不限速率)。落在
// 送审第一段而不是各入口: 现有与新增的送审面都要先过这里, 返回类型带 string, 调用点不处理
// 编译不过。只数 dry_run = false 的 pending: 与 hasPendingModeration 同口径, 灰度不挡人;
// 转人工的任务不占 worker。判定在写事务之前, 超限时什么都没写; 它是先查后写, 并发提交能
// 超出几条, 超出量由入口的频率预算 (server/abuse) 封顶
const pendingLimitError = async (actor: KunActor) => {
  if (can(actor, 'abuse.exempt')) {
    return null
  }
  const pending = await prisma.moderation_task.count({
    where: { user_id: actor.uid, status: 'pending', dry_run: false }
  })
  return pending >= MODERATION_MAX_PENDING_PER_USER
    ? `您已有 ${pending} 条内容在等待审核, 请等审核完成后再提交`
    : null
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
    // 失败类别随之清掉: 它描述的是「还挂着的任务卡在哪」, 已作废的任务不该再被
    // 管理端按失败类别筛出来
    data: { status: 'superseded', failure_kind: '' }
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
