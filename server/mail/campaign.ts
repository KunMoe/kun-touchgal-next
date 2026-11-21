import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { sendKunEmail } from '~/app/api/utils/sendKunEmail'
import {
  isCampaignTemplateId,
  renderCampaignEmail
} from '~/constants/email/campaign'
import {
  MAIL_CAMPAIGN_BATCH_SIZE,
  MAIL_CAMPAIGN_MIN_BATCH_INTERVAL_MS,
  MAIL_CAMPAIGN_PAUSE_FAILURE_RATIO
} from '~/constants/admin'
import { sliceCodePoints } from '~/utils/text/unicode'
import { createUnsubscribeUrl } from './unsubscribeToken'
import type { CampaignTemplateId } from '~/constants/email/campaign'
import type { KunActor } from '~/constants/role'
import type { AdminMailCampaign } from '~/types/api/admin'

// 群发邮件是一个持久化的任务 (mail_campaign 的一行), 不是一次请求: 路由只建任务, 定时任务
// 进程 (server/tasks/mailCampaignTask.ts) 每分钟调一次 runCampaignStep, 沿 user 主键按游标
// 一批一批地发。进度只存在任务行里, 所以进程被杀、部署、超时都只是「下一拍接着发」。
//
// 投递语义是至少一次: 先发出一批, 再推进游标。进程死在两者之间时这一批会重发, 重复的上界
// 是一批 (MAIL_CAMPAIGN_BATCH_SIZE 封); 反过来先推进再发的话, 同样的崩溃会让这一批人
// 永远收不到。
//
// 推进游标的那条条件更新 (WHERE id、status = 'sending'、cursor_user_id = 发这一批之前的
// 游标) 同时是三件事: 进度落库、取消检测 (任务被取消后它命中 0 行)、重叠防护 (万一有两个
// 进程在推进同一个任务, 落后的那个命中 0 行, 最多多发一批)。命中 0 行就停, 不再取下一批。
// 它的守卫必须平铺在 UPDATE 自己的 WHERE 里, 由 __tests__/campaign.sql.test.ts 守着

// 通告锁命名空间 (pg_advisory_xact_lock 首参), 接续 481001~481004 (补丁类型 / 评分统计 /
// 收藏 / 点赞); 第二个参数固定为 0: 全站同一时刻至多一个进行中的群发
const MAIL_CAMPAIGN_LOCK_NAMESPACE = 481005

// 还没有结束的任务: 发送中, 或因失败率过高自动暂停、等管理员决定继续还是取消
const ACTIVE_STATUSES = ['sending', 'paused']

// last_error 的列宽
const LAST_ERROR_LIMIT = 1007

export const createCampaign = async (
  input: { templateId: CampaignTemplateId; title: string; contentHtml: string },
  actor: KunActor
): Promise<{ campaignId: number } | string> =>
  kunTx('mail.campaign.create', async ({ tx, fail }) => {
    // 「没有进行中的任务才能新建」是查后插: 两个并发的创建各自都看不到对方还没提交的行,
    // 先在通告锁上排队, 后到的那个拿到锁时前一个已经提交
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MAIL_CAMPAIGN_LOCK_NAMESPACE}::int, 0)`

    const active = await tx.mail_campaign.findFirst({
      where: { status: { in: ACTIVE_STATUSES } },
      select: { id: true }
    })
    if (active) {
      fail(`群发任务 #${active.id} 还没有结束, 等它发完或取消之后才能再发起`)
    }

    // 收件范围在这里定格: 之后注册的用户不在这一次群发里
    const newest = await tx.user.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true }
    })
    const maxUserId = newest?.id ?? 0
    const total = await tx.user.count({
      where: { id: { lte: maxUserId }, enable_email_notice: true }
    })

    const campaign = await tx.mail_campaign.create({
      data: {
        template_id: input.templateId,
        title: input.title,
        content_html: input.contentHtml,
        max_user_id: maxUserId,
        total,
        created_by: actor.uid
      },
      select: { id: true }
    })
    await tx.admin_log.create({
      data: {
        type: 'create',
        user_id: actor.uid,
        content: `管理员 ${actor.name} 发起了群发邮件任务 #${campaign.id} (模板 ${input.templateId}, 预计 ${total} 封)\n标题: ${input.title}`
      }
    })

    return { campaignId: campaign.id }
  })

export const transitionCampaign = async (
  campaignId: number,
  action: 'cancel' | 'resume',
  actor: KunActor
): Promise<{} | string> => {
  const failure = await kunTx(
    'mail.campaign.transition',
    async ({ tx, fail }) => {
      const { count } =
        action === 'cancel'
          ? await tx.mail_campaign.updateMany({
              where: { id: campaignId, status: { in: ACTIVE_STATUSES } },
              data: { status: 'cancelled', finished: new Date() }
            })
          : await tx.mail_campaign.updateMany({
              where: { id: campaignId, status: 'paused' },
              data: { status: 'sending', last_error: '' }
            })
      if (count === 0) {
        fail(
          action === 'cancel'
            ? '这个群发任务已经结束了'
            : '只有暂停中的群发任务可以继续发送'
        )
      }

      await tx.admin_log.create({
        data: {
          type: 'update',
          user_id: actor.uid,
          content: `管理员 ${actor.name} ${action === 'cancel' ? '取消了' : '继续发送'}群发邮件任务 #${campaignId}`
        }
      })
    }
  )
  return failure ?? {}
}

export const listCampaigns = async (
  take: number
): Promise<AdminMailCampaign[]> => {
  const campaigns = await prisma.mail_campaign.findMany({
    orderBy: { id: 'desc' },
    take,
    select: {
      id: true,
      template_id: true,
      title: true,
      status: true,
      total: true,
      sent: true,
      failed: true,
      last_error: true,
      created: true,
      finished: true,
      creator: { select: { id: true, name: true, avatar: true } }
    }
  })

  return campaigns.map((campaign) => ({
    id: campaign.id,
    templateId: campaign.template_id,
    title: campaign.title,
    status: campaign.status,
    total: campaign.total,
    sent: campaign.sent,
    failed: campaign.failed,
    lastError: campaign.last_error,
    creator: campaign.creator,
    created: campaign.created,
    finished: campaign.finished
  }))
}

interface CampaignMail {
  template_id: string
  title: string
  content_html: string
}

// 发给一个收件人; 任何失败都以异常表达, 由调用方按批统计
const sendToRecipient = async (
  campaign: CampaignMail,
  recipient: { id: number; email: string }
) => {
  // 任务创建之后模板被从代码里删掉了: 这一批全部失败, 任务随之自动暂停
  if (!isCampaignTemplateId(campaign.template_id)) {
    throw new Error(`邮件模板 ${campaign.template_id} 不存在`)
  }

  const { subject, html } = renderCampaignEmail(
    campaign.template_id,
    { titleHtml: campaign.title, contentHtml: campaign.content_html },
    createUnsubscribeUrl(recipient.id)
  )
  const error = await sendKunEmail({
    to: [recipient.email],
    subject,
    tag: campaign.template_id,
    html_body: html,
    plain_body: '请在支持 HTML 的邮件客户端中查看此邮件'
  })
  if (error) {
    throw new Error(error)
  }
}

// 游标已经越过收件范围: 把任务标成完成并记日志。任务此刻已不在 sending (被取消),
// 或游标被别的进程推进过, 则什么都不写
const finishCampaign = async (campaignId: number, cursor: number) => {
  const failure = await kunTx('mail.campaign.finish', async ({ tx, fail }) => {
    const { count } = await tx.mail_campaign.updateMany({
      where: { id: campaignId, status: 'sending', cursor_user_id: cursor },
      data: { status: 'done', finished: new Date() }
    })
    if (count === 0) {
      fail('任务已不在发送中')
    }

    const finished = await tx.mail_campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { sent: true, failed: true, created_by: true }
    })
    await tx.admin_log.create({
      data: {
        type: 'update',
        user_id: finished.created_by,
        content: `群发邮件任务 #${campaignId} 已发送完毕 (成功 ${finished.sent} 封, 失败 ${finished.failed} 封)`
      }
    })
  })
  return failure === undefined
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const messageOf = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason)

// sent / failed 是这一拍里发出并已记进任务行的数量, 不是任务的累计值
export type CampaignStepResult =
  | { kind: 'idle' }
  // 时间预算用完, 任务还没发完, 下一拍接着推进
  | { kind: 'progress'; campaignId: number; sent: number; failed: number }
  | { kind: 'done'; campaignId: number; sent: number; failed: number }
  | {
      kind: 'paused'
      campaignId: number
      sent: number
      failed: number
      reason: string
    }
  // 任务已不在这个进程手里: 被取消了, 或游标被别的进程推进过。刚发出的那一批没有记进任务行
  | { kind: 'stopped'; campaignId: number; sent: number; failed: number }

// 推进最早的一个发送中的任务, 直到发完、自动暂停、被取消, 或 signal 中止 (调用方用它给
// 一拍定时间预算; 只在两批之间检查, 已经发出的那一批总会推进完游标)
export const runCampaignStep = async ({
  signal
}: {
  signal: AbortSignal
}): Promise<CampaignStepResult> => {
  const campaign = await prisma.mail_campaign.findFirst({
    where: { status: 'sending' },
    orderBy: { id: 'asc' }
  })
  if (!campaign) {
    return { kind: 'idle' }
  }

  const campaignId = campaign.id
  let cursor = campaign.cursor_user_id
  let sent = 0
  let failed = 0

  while (!signal.aborted) {
    // 走 user 主键, 不需要新索引。enable_email_notice 每批现查: 群发期间退订的人即时生效
    const recipients = await prisma.user.findMany({
      where: {
        id: { gt: cursor, lte: campaign.max_user_id },
        enable_email_notice: true
      },
      orderBy: { id: 'asc' },
      take: MAIL_CAMPAIGN_BATCH_SIZE,
      select: { id: true, email: true }
    })
    if (!recipients.length) {
      return (await finishCampaign(campaignId, cursor))
        ? { kind: 'done', campaignId, sent, failed }
        : { kind: 'stopped', campaignId, sent, failed }
    }

    const results = await Promise.allSettled(
      recipients.map((recipient) => sendToRecipient(campaign, recipient))
    )
    const rejected = results.filter((result) => result.status === 'rejected')
    const bad = rejected.length
    const ok = recipients.length - bad
    const nextCursor = recipients[recipients.length - 1].id

    // 失败率过高多半是中继出了问题: 记下这一批、停在这里, 等管理员确认之后继续。这一批里
    // 失败的收件人不会重发 (只有计数, 没有逐人的台账)
    const pauseReason =
      bad > 0 && bad / recipients.length >= MAIL_CAMPAIGN_PAUSE_FAILURE_RATIO
        ? sliceCodePoints(
            `一批 ${recipients.length} 封里有 ${bad} 封发送失败, 已自动暂停。其中一封的错误: ${messageOf(rejected[0].reason)}`,
            LAST_ERROR_LIMIT
          )
        : null

    const { count } = await prisma.mail_campaign.updateMany({
      where: { id: campaignId, status: 'sending', cursor_user_id: cursor },
      data: {
        cursor_user_id: nextCursor,
        sent: { increment: ok },
        failed: { increment: bad },
        ...(pauseReason ? { status: 'paused', last_error: pauseReason } : {})
      }
    })
    if (count === 0) {
      return { kind: 'stopped', campaignId, sent, failed }
    }

    cursor = nextCursor
    sent += ok
    failed += bad
    if (pauseReason) {
      return { kind: 'paused', campaignId, sent, failed, reason: pauseReason }
    }

    await sleep(MAIL_CAMPAIGN_MIN_BATCH_INTERVAL_MS)
  }

  return { kind: 'progress', campaignId, sent, failed }
}
