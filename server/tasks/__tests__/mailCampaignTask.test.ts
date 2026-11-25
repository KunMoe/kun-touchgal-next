import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runCampaignStepMock } = vi.hoisted(() => ({
  runCampaignStepMock: vi.fn()
}))

vi.mock('~/server/mail/campaign', () => ({
  runCampaignStep: runCampaignStepMock
}))

import { mailCampaignJob } from '~/server/tasks/mailCampaignTask'
import {
  MAIL_CAMPAIGN_MIN_BATCH_INTERVAL_MS,
  MAIL_CAMPAIGN_STEP_BUDGET_MS
} from '~/constants/admin'
import { SEND_EMAIL_TIMEOUT_MS } from '~/app/api/utils/sendKunEmail'

// 作业层交给 run 的 signal: 关停或租约丢失时中止
let stop: AbortController
const tick = () =>
  mailCampaignJob.run({
    signal: stop.signal,
    cancelSignal: new AbortController().signal,
    progress: () => {}
  })

beforeEach(() => {
  vi.resetAllMocks()
  stop = new AbortController()
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

  // 跨进程互斥与「没拿到就不做」由作业层按 spec.lease 执行 (server/jobs/__tests__/registry.test.ts)
  it('持群发任务的租约推进一步', () => {
    expect(mailCampaignJob.lease).toEqual({ key: 'mail:campaign:lock' })
  })

  // AbortSignal.timeout 的计时不受假时钟控制: 换成一个手动中止的 signal, 看它是用哪个时长建的、
  // 到点时这一步的 signal 是否随之中止
  it('交给这一步的 signal 按一拍的时间预算定时中止', async () => {
    const budget = new AbortController()
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(budget.signal)
    try {
      await tick()

      expect(timeout).toHaveBeenCalledExactlyOnceWith(
        MAIL_CAMPAIGN_STEP_BUDGET_MS
      )
      const [[{ signal }]] = runCampaignStepMock.mock.calls
      expect(signal.aborted).toBe(false)
      budget.abort()
      expect(signal.aborted).toBe(true)
    } finally {
      timeout.mockRestore()
    }
  })

  it('关停或租约丢失 (作业层的 signal 中止) 时, 交给这一步的 signal 随之中止', async () => {
    await tick()
    const [[{ signal }]] = runCampaignStepMock.mock.calls

    const reason = new Error('stopping')
    stop.abort(reason)

    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe(reason)
  })

  // 作业层按作业名记下它 (server/jobs/registry.ts), 不逃出定时器
  it('推进抛错时交给作业层', async () => {
    runCampaignStepMock.mockRejectedValue(new Error('db down'))

    await expect(tick()).rejects.toThrow('db down')
  })
})
