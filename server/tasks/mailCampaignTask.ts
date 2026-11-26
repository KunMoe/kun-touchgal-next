import { MAIL_CAMPAIGN_STEP_BUDGET_MS } from '~/constants/admin'
import { kunLog } from '~/lib/log.server'
import { defineScheduledJob } from '~/server/jobs/registry'
import { runCampaignStep } from '~/server/mail/campaign'

// 每分钟推进一次进行中的群发任务。没有任务时只是一次按 status 的索引查询。
// 作业层在进程内不让两拍叠在一起, 租约管跨进程; 真叠了也只多发一批, 由推进游标的条件更新兜底。
// 交给这一步的 signal 在一拍的预算用完、关停或租约丢失时中止, 都只在两批之间生效
export const mailCampaignJob = defineScheduledJob({
  name: 'mail_campaign',
  schedule: '* * * * *',
  lease: { key: 'mail:campaign:lock' },
  run: async ({ signal }) => {
    const result = await runCampaignStep({
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(MAIL_CAMPAIGN_STEP_BUDGET_MS)
      ])
    })
    if (result.kind !== 'idle') {
      // 每拍一行, 可 grep (pm2 logs | grep mail.campaign_step): 发到哪了、为什么停
      kunLog('mail.campaign_step', { ...result })
    }
  }
})
