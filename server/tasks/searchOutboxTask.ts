import cron from 'node-cron'
import { drainSearchOutbox } from '~/server/search/sync'

// 每轮最多连续消费这么久，留出余量给下一分钟的调度：积压 (对账发现的整批漂移、构建器输出
// 变化后的整库重投影) 按约 50 秒一分钟连续排空，而不是每分钟只处理一批
const OUTBOX_TASK_BUDGET_MS = 50_000

// 每分钟兜底消费搜索写出箱：即时 kick 抢不到锁、或崩溃 worker 遗留的行在此被拉起重试。
// drainSearchOutbox 内部已用写锁保证单一消费者，无需在此重复加锁。
export const searchOutboxTask = cron.createTask('* * * * *', async () => {
  await drainSearchOutbox({ budgetMs: OUTBOX_TASK_BUDGET_MS }).catch(
    (error) => {
      console.error('搜索写出箱定时消费失败:', error)
    }
  )
})
