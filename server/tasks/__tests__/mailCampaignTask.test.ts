import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createTaskMock, runCampaignStepMock, withTaskLockMock } = vi.hoisted(
  () => ({
    createTaskMock: vi.fn(),
    runCampaignStepMock: vi.fn(),
    withTaskLockMock: vi.fn()
  })
)

vi.mock('node-cron', () => ({ default: { createTask: createTaskMock } }))

vi.mock('~/server/mail/campaign', () => ({
  runCampaignStep: runCampaignStepMock
}))

vi.mock('~/server/tasks/withTaskLock', () => ({
  withTaskLock: withTaskLockMock
}))

import '~/server/tasks/mailCampaignTask'
import {
  MAIL_CAMPAIGN_MIN_BATCH_INTERVAL_MS,
  MAIL_CAMPAIGN_STEP_BUDGET_MS
} from '~/constants/admin'
import { SEND_EMAIL_TIMEOUT_MS } from '~/app/api/utils/sendKunEmail'

// 模块加载时登记的那一次, 先留下来: 下面每个用例都会清空 mock 的调用记录
const [schedule, tick, options] = createTaskMock.mock.calls[0] as [
  string,
  () => Promise<void>,
  { noOverlap?: boolean }
]

beforeEach(() => {
  vi.resetAllMocks()
  withTaskLockMock.mockImplementation(async (_options, task) => task())
  runCampaignStepMock.mockResolvedValue({ kind: 'idle' })
})

describe('mailCampaignTask', () => {
  it('每分钟一拍, 上一拍没结束时不叠下一拍', () => {
    expect(schedule).toBe('* * * * *')
    expect(options).toEqual({ noOverlap: true })
  })

  // 一拍最坏的情形: 预算快用完时又开了一批, 这一批里有邮件一直等到超时
  it('一拍的时间预算加批间隔与单封邮件的超时, 小于调度周期', () => {
    expect(
      MAIL_CAMPAIGN_STEP_BUDGET_MS +
        MAIL_CAMPAIGN_MIN_BATCH_INTERVAL_MS +
        SEND_EMAIL_TIMEOUT_MS
    ).toBeLessThan(60 * 1000)
  })

  it('在任务锁里推进一步, 锁的寿命比一拍长', async () => {
    await tick()

    expect(withTaskLockMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: 'mail:campaign:lock' }),
      expect.any(Function)
    )
    const [{ ttlSeconds }] = withTaskLockMock.mock.calls[0]
    expect(ttlSeconds * 1000).toBeGreaterThan(60 * 1000)
    expect(runCampaignStepMock).toHaveBeenCalledExactlyOnceWith({
      signal: expect.any(AbortSignal)
    })
  })

  // AbortSignal.timeout 的计时不受假时钟控制, 所以看它是用哪个时长建的
  it('交给这一步的 signal 按一拍的时间预算定时中止', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      await tick()

      expect(timeout).toHaveBeenCalledExactlyOnceWith(
        MAIL_CAMPAIGN_STEP_BUDGET_MS
      )
      expect(runCampaignStepMock).toHaveBeenCalledExactlyOnceWith({
        signal: timeout.mock.results[0].value
      })
    } finally {
      timeout.mockRestore()
    }
  })

  it('没拿到锁时这一拍什么都不做', async () => {
    withTaskLockMock.mockResolvedValue(undefined)

    await tick()

    expect(runCampaignStepMock).not.toHaveBeenCalled()
  })

  it('推进抛错时只记日志, 不让异常逃出定时任务', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    runCampaignStepMock.mockRejectedValue(new Error('db down'))

    await expect(tick()).resolves.toBeUndefined()

    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })
})
