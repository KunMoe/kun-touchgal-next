import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runCampaignStepMock, withTaskLockMock } = vi.hoisted(() => ({
  runCampaignStepMock: vi.fn(),
  withTaskLockMock: vi.fn()
}))

vi.mock('~/server/mail/campaign', () => ({
  runCampaignStep: runCampaignStepMock
}))

vi.mock('~/server/tasks/withTaskLock', () => ({
  withTaskLock: withTaskLockMock
}))

import { mailCampaignJob } from '~/server/tasks/mailCampaignTask'
import {
  MAIL_CAMPAIGN_MIN_BATCH_INTERVAL_MS,
  MAIL_CAMPAIGN_STEP_BUDGET_MS
} from '~/constants/admin'
import { SEND_EMAIL_TIMEOUT_MS } from '~/app/api/utils/sendKunEmail'

const tick = () =>
  mailCampaignJob.run({
    signal: new AbortController().signal,
    cancelSignal: new AbortController().signal
  })

beforeEach(() => {
  vi.resetAllMocks()
  withTaskLockMock.mockImplementation(async (_options, task) => task())
  runCampaignStepMock.mockResolvedValue({ kind: 'idle' })
})

describe('mailCampaignTask', () => {
  // 上一拍没结束时不叠下一拍由作业层保证 (server/jobs/__tests__/registry.test.ts)
  it('每分钟一拍', () => {
    expect(mailCampaignJob.schedule).toBe('* * * * *')
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

  // 作业层按作业名记下它 (server/jobs/registry.ts), 不逃出定时器
  it('推进抛错时交给作业层', async () => {
    runCampaignStepMock.mockRejectedValue(new Error('db down'))

    await expect(tick()).rejects.toThrow('db down')
  })
})
