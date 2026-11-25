import { MAIL_CAMPAIGN_STEP_BUDGET_MS } from '~/constants/admin'
import { defineScheduledJob } from '~/server/jobs/registry'
import { runCampaignStep } from '~/server/mail/campaign'
import { withTaskLock } from './withTaskLock'

const MAIL_CAMPAIGN_LOCK_KEY = 'mail:campaign:lock'
// 一拍最长是「预算 + 批间隔 + 单封邮件的超时」, 不到一分钟 (constants/admin.ts)。锁的寿命
// 留足余量: 持锁的进程被杀之后, 最迟这么久另一个进程才能接手
const MAIL_CAMPAIGN_LOCK_TTL_SECONDS = 120

// 每分钟推进一次进行中的群发任务。没有任务时只是一次按 status 的索引查询。
// 作业层在进程内不让两拍叠在一起, 任务锁管跨进程; 真叠了也只多发一批, 由推进游标的条件更新兜底
export const mailCampaignJob = defineScheduledJob({
  name: 'mail_campaign',
  schedule: '* * * * *',
  run: () =>
    withTaskLock(
      {
        key: MAIL_CAMPAIGN_LOCK_KEY,
        ttlSeconds: MAIL_CAMPAIGN_LOCK_TTL_SECONDS,
        taskName: 'mailCampaignTask'
      },
      async () => {
        const result = await runCampaignStep({
          signal: AbortSignal.timeout(MAIL_CAMPAIGN_STEP_BUDGET_MS)
        })
        if (result.kind !== 'idle') {
          // 每拍一行, 可 grep (pm2 logs | grep kun-mail-campaign): 发到哪了、为什么停
          // eslint-disable-next-line no-console
          console.log(`[kun-mail-campaign] ${JSON.stringify(result)}`)
        }
      }
    )
})
