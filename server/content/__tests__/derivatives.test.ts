import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)

vi.mock('~/prisma/index', () => rec.module)
// submit.ts 读审核配置要连 Redis; 这里只用到它的 deletePendingModerationTasks
vi.mock('~/server/moderation/config', () => ({ getModerationConfig: vi.fn() }))

import { kunTx } from '~/server/db/tx'
import { purgeContentDerivatives } from '~/server/content/derivatives'

beforeEach(() => {
  rec.reset()
})

describe('purgeContentDerivatives', () => {
  it('先清三类内容未决的审核任务, 再清未处理的申诉', async () => {
    await kunTx('probe', async ({ tx }) => {
      await purgeContentDerivatives(tx, {
        comment: [1, 2],
        rating: [3],
        resource: [4]
      })
    })

    expect(rec.labels()).toEqual([
      'moderation_task.deleteMany',
      'moderation_task.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'moderation_appeal.deleteMany',
      'moderation_appeal.deleteMany'
    ])
    // 只清还没有结论的: 已通过 / 已拒绝的任务与申诉留作历史
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      {
        where: {
          content_type: 'comment',
          content_id: { in: [1, 2] },
          status: { in: ['pending', 'manual'] }
        }
      },
      {
        where: {
          content_type: 'rating',
          content_id: { in: [3] },
          status: { in: ['pending', 'manual'] }
        }
      },
      {
        where: {
          content_type: 'resource',
          content_id: { in: [4] },
          status: { in: ['pending', 'manual'] }
        }
      }
    ])
    expect(rec.argsOf('moderation_appeal.deleteMany')).toEqual([
      {
        where: {
          content_type: 'comment',
          content_id: { in: [1, 2] },
          status: 'pending'
        }
      },
      {
        where: {
          content_type: 'rating',
          content_id: { in: [3] },
          status: 'pending'
        }
      },
      {
        where: {
          content_type: 'resource',
          content_id: { in: [4] },
          status: 'pending'
        }
      }
    ])
  })

  it('没给的内容类型不发语句', async () => {
    await kunTx('probe', async ({ tx }) => {
      await purgeContentDerivatives(tx, { rating: [3] })
    })

    expect(rec.labels()).toEqual([
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany'
    ])
  })
})
