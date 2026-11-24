import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { KunTxContext } from '~/server/db/tx'
import { submitAppealSchema } from '~/validations/appeal'
import { renderKunMarkdownForWrite } from '~/app/api/utils/render/renderKunMarkdown'
import {
  APPEAL_LINK_SELECT,
  getAppealModelName
} from '~/server/moderation/appeal'
import { getAppealEditableLinkFields } from '~/utils/appealPayload'
import { toWellFormedDeep } from '~/utils/text/unicode'
import type {
  AppealLink,
  AppealPayload,
  AppealResourceField
} from '~/types/api/appeal'

type SubmitAppealInput = z.infer<typeof submitAppealSchema>
type ResourceAppealInput = Extract<
  SubmitAppealInput,
  { contentType: 'resource' }
>

// 校验申诉目标内容仍归属本人且处于隐藏状态
const checkContentAppealable = async (
  contentType: string,
  contentId: number,
  uid: number
) => {
  if (contentType === 'comment') {
    const comment = await prisma.patch_comment.findUnique({
      where: { id: contentId },
      select: { user_id: true, status: true }
    })
    return !!comment && comment.user_id === uid && comment.status === 2
  }
  if (contentType === 'rating') {
    const rating = await prisma.patch_rating.findUnique({
      where: { id: contentId },
      select: { user_id: true, status: true }
    })
    return !!rating && rating.user_id === uid && rating.status === 2
  }
  const resource = await prisma.patch_resource.findUnique({
    where: { id: contentId },
    select: { user_id: true, status: true }
  })
  return !!resource && resource.user_id === uid && resource.status === 1
}

// 用 FOR UPDATE 锁定目标内容行, 与并发的内容删除在该行上互斥;
// 返回 false 表示内容已被删除或状态已变更 (不再是可申诉的隐藏态)
const lockContentForAppeal = async (
  contentType: string,
  contentId: number,
  uid: number,
  tx: Prisma.TransactionClient
) => {
  if (contentType === 'comment') {
    const rows = await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM patch_comment
      WHERE id = ${contentId} AND user_id = ${uid} AND status = 2
      FOR UPDATE
    `
    return rows.length > 0
  }
  if (contentType === 'rating') {
    const rows = await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM patch_rating
      WHERE id = ${contentId} AND user_id = ${uid} AND status = 2
      FOR UPDATE
    `
    return rows.length > 0
  }
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT id FROM patch_resource
    WHERE id = ${contentId} AND user_id = ${uid} AND status = 1
    FOR UPDATE
  `
  return rows.length > 0
}

// 资源申诉的链接必须与库中的链接行一一对应: 申诉只改已有链接的字段, 不增删链接。须在
// 资源行锁下调用 (资源编辑先锁资源行再整体重建链接行)。storage 一律以库为准; 作者
// 不可改的字段 (见 getAppealEditableLinkFields) 即使提交了也不取, 一律保留库中的值
const buildResourceAppealLinks = async (
  resourceId: number,
  inputLinks: ResourceAppealInput['links'],
  ctx: KunTxContext
) => {
  const { tx } = ctx
  const currentLinks = await tx.patch_resource_link.findMany({
    where: { resource_id: resourceId },
    orderBy: { sort_order: 'asc' },
    select: APPEAL_LINK_SELECT
  })
  if (inputLinks.length !== currentLinks.length) {
    ctx.fail('资源链接已变更, 请刷新后重试')
  }

  const inputById = new Map(inputLinks.map((link) => [link.id, link]))
  const links: AppealLink[] = []
  for (const current of currentLinks) {
    const submitted = inputById.get(current.id)
    if (!submitted) {
      ctx.fail('资源链接已变更, 请刷新后重试')
    }
    const editable = getAppealEditableLinkFields(current.storage)
    const link: AppealLink = { ...current }
    for (const field of editable) {
      const value = submitted[field]
      // 可改的字段必须随请求提交; 缺了说明页面上的链接与库中的对不上
      if (value === undefined) {
        ctx.fail('资源链接已变更, 请刷新后重试')
      }
      link[field] = value
    }
    if (editable.includes('content') && !link.content.trim()) {
      ctx.fail('请输入资源链接')
    }
    links.push(link)
  }
  return links
}

// 模型型号只在 AI 翻译补丁的申诉里可改, 且与发布 / 编辑资源时一样必填; 其余类型的资源
// 没有这个字段, 提交了也不取。须在资源行锁下调用
const resolveAppealModelName = async (
  resourceId: number,
  submitted: string | undefined,
  ctx: KunTxContext
) => {
  const { tx } = ctx
  const resource = await tx.patch_resource.findUniqueOrThrow({
    where: { id: resourceId },
    select: { type: true, model_name: true }
  })
  if (getAppealModelName(resource) === undefined) {
    return undefined
  }
  if (!submitted) {
    ctx.fail('请填写模型型号')
  }
  return submitted
}

const buildResourceAppealPayload = async (
  resourceId: number,
  input: ResourceAppealInput,
  ctx: KunTxContext
): Promise<AppealPayload> => {
  // 资源本体上送审的字段都要在这里交代去向: 策略表新增送审字段而这里没有时编译失败
  const fields: Record<AppealResourceField, string | undefined> = {
    name: input.name,
    note: input.note,
    modelName: await resolveAppealModelName(resourceId, input.modelName, ctx)
  }
  return {
    ...fields,
    links: await buildResourceAppealLinks(resourceId, input.links, ctx)
  }
}

export const submitAppeal = async (input: SubmitAppealInput, uid: number) => {
  const task = await prisma.moderation_task.findUnique({
    where: { id: input.taskId },
    include: { appeal: true }
  })
  if (!task || task.user_id !== uid) {
    return '未找到该审核记录'
  }
  if (
    task.status !== 'rejected' ||
    task.dry_run ||
    !task.content_id ||
    task.content_type !== input.contentType
  ) {
    return '该审核记录不可申诉'
  }
  // 申诉只能提交一次, 提交后 payload 锁定不可修改: 避免用户在管理员复核过程中
  // 把已展示给管理员的无害内容换成违规内容 (申诉通过不再走 AI 复审)
  if (task.appeal) {
    return '您已提交过申诉, 无法重复提交'
  }

  const contentId = task.content_id
  if (!(await checkContentAppealable(input.contentType, contentId, uid))) {
    return '内容不存在或状态已变更, 无法申诉'
  }

  // 同一内容可能有多条被拒任务 (管理员恢复后再次被拒), 只允许在最新一条上申诉,
  // 防止同一内容产生多个待处理申诉
  const newerTask = await prisma.moderation_task.findFirst({
    where: {
      content_type: input.contentType,
      content_id: contentId,
      status: 'rejected',
      dry_run: false,
      id: { gt: task.id }
    },
    select: { id: true }
  })
  if (newerTask) {
    return '该审核记录已失效, 请在最新的拒绝记录上申诉'
  }
  const otherPendingAppeal = await prisma.moderation_appeal.findFirst({
    where: {
      content_type: input.contentType,
      content_id: contentId,
      status: 'pending',
      task_id: { not: task.id }
    },
    select: { id: true }
  })
  if (otherPendingAppeal) {
    return '该内容已有待处理的申诉'
  }

  // 申诉通过时这段正文会原样写回评论 / 资源备注: 渲染不出来的内容在提交时就拒绝,
  // 用户当场得到反馈 (评价的简评是纯文本, 不经渲染)
  const renderable =
    input.contentType === 'comment'
      ? await renderKunMarkdownForWrite('comment', input.content)
      : input.contentType === 'resource'
        ? await renderKunMarkdownForWrite('note', input.note)
        : null
  if (typeof renderable === 'string') {
    return renderable
  }

  // 事务内先 FOR UPDATE 锁内容行再重校验存活, 与并发的内容删除互斥:
  // 删除先提交则此处锁到时内容已消失而拒绝; 本事务先提交则删除方在删内容后清理掉本申诉,
  // 两个方向都不会残留孤儿 pending 申诉 (task_id 唯一约束仍兜底并发重复提交)
  const failure = await kunTx('appeal.submit', async (ctx) => {
    const { tx } = ctx
    if (!(await lockContentForAppeal(input.contentType, contentId, uid, tx))) {
      ctx.fail('内容不存在或状态已变更, 无法申诉')
    }
    const payload: AppealPayload =
      input.contentType === 'resource'
        ? await buildResourceAppealPayload(contentId, input, ctx)
        : {
            text:
              input.contentType === 'comment'
                ? input.content
                : input.shortSummary
          }
    await tx.moderation_appeal.create({
      data: {
        content_type: input.contentType,
        content_id: contentId,
        task_id: task.id,
        user_id: uid,
        payload: toWellFormedDeep(payload) as unknown as Prisma.InputJsonValue
      }
    })
  })

  return failure ?? {}
}
