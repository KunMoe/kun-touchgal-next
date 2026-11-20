import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectFlatConditionalUpdate } from '~/prisma/__tests__/support/sqlShape'

// 每日图片额度的抢占与退还依赖的编译器输出, 不连库

const recorder = await vi.hoisted(async () =>
  (await import('~/prisma/__tests__/support/sqlRecorder')).createSqlRecorder()
)

vi.mock('~/prisma/index', () => recorder.module)

import {
  DAILY_IMAGE_LIMIT,
  claimDailyImageQuota,
  refundDailyImageQuota
} from '~/app/api/utils/imageQuota'

beforeEach(() => {
  recorder.reset()
})

describe('每日图片额度发出的 SQL', () => {
  it('抢占是一条 UPDATE, 上限的判定平铺在它自己的 WHERE 里', async () => {
    await expect(claimDailyImageQuota(7)).resolves.toBe(true)

    const statements = recorder.take()
    expect(statements).toHaveLength(1)
    const update = expectFlatConditionalUpdate(statements, {
      table: 'user',
      guards: ['id', 'daily_image_count']
    })
    expect(update.sql).toMatch(/"daily_image_count" < \$\d+/)
    expect(update.values).toContain(DAILY_IMAGE_LIMIT)
  })

  it('库报告影响 0 行时抢占失败', async () => {
    recorder.reply(/^UPDATE "public"\."user"/, { rowCount: 0 })

    await expect(claimDailyImageQuota(7)).resolves.toBe(false)
  })

  it('退还同样是一条平铺 WHERE 的 UPDATE, 带着不减成负数的下限', async () => {
    await refundDailyImageQuota(7)

    const statements = recorder.take()
    expect(statements).toHaveLength(1)
    const update = expectFlatConditionalUpdate(statements, {
      table: 'user',
      guards: ['id', 'daily_image_count']
    })
    expect(update.sql).toMatch(/"daily_image_count" >= \$\d+/)
  })
})
