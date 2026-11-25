import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { moderation_taskModel } from '~/prisma/generated/prisma/models'

const {
  transactionMock,
  executeRawMock,
  claimMock,
  updateUserMock,
  transitionCommentsMock,
  transitionRatingsMock,
  transitionResourcesMock,
  invalidateUnreadMock,
  taskUpdateMock
} = vi.hoisted(() => ({
  taskUpdateMock: vi.fn(),
  transactionMock: vi.fn(),
  executeRawMock: vi.fn(),
  claimMock: vi.fn(),
  updateUserMock: vi.fn(),
  transitionCommentsMock: vi.fn(),
  transitionRatingsMock: vi.fn(),
  transitionResourcesMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

const transactionClient = {
  $executeRaw: executeRawMock,
  moderation_task: { updateMany: claimMock },
  user: { update: updateUserMock }
}

const events: string[] = []

vi.mock('~/prisma/index', () => ({
  prisma: {
    $transaction: transactionMock,
    moderation_task: { updateMany: taskUpdateMock }
  }
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: vi.fn()
}))

// 内容状态迁移的锁、聚合重算、缓存失效与通知补发由命令自己的测试覆盖;
// 这里只看裁决怎么用它们
vi.mock('~/server/content/comment/transition', () => ({
  transitionComments: transitionCommentsMock
}))

vi.mock('~/server/content/rating/transition', () => ({
  transitionRatings: transitionRatingsMock
}))

vi.mock('~/server/content/resource/transition', () => ({
  transitionResources: transitionResourcesMock
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

vi.mock('~/app/api/utils/purgeCloudflareCache', () => ({
  purgeCloudflareCache: vi.fn()
}))

vi.mock('~/lib/s3', () => ({
  copyObject: vi.fn(),
  deleteFileFromS3: vi.fn()
}))

import {
  applyModerationVerdict,
  markTaskManual,
  requeueModerationTask
} from '~/server/moderation/apply'
import { DependencyFailure } from '~/lib/resilience/failure'
import { Prisma } from '~/prisma/generated/prisma/client'
import { purgeCloudflareCache } from '~/app/api/utils/purgeCloudflareCache'
import { copyObject, deleteFileFromS3 } from '~/lib/s3'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { createMessage } from '~/app/api/utils/message'
import {
  MODERATION_REJECT_CODE_MAP,
  MODERATION_REJECT_NOTICE
} from '~/constants/moderation'
import { APPEAL_SETTINGS_LINK } from '~/constants/appeal'

const created = new Date('2026-01-01T00:00:00.000Z')
const ratingTask = (overrides: Partial<moderation_taskModel> = {}) =>
  ({
    id: 1,
    content_type: 'rating',
    content_id: 5,
    patch_id: 10,
    payload: { text: 'kun' },
    status: 'pending',
    reject_code: '',
    reject_reason: '',
    verdict: null,
    model: '',
    tokens_in: 0,
    tokens_out: 0,
    retry: 0,
    defer_count: 0,
    failure_kind: '',
    next_attempt: created,
    picked_at: null,
    dry_run: false,
    reviewed: null,
    user_id: 100,
    created,
    updated: created,
    ...overrides
  }) as moderation_taskModel

const joinSql = (call: unknown[]) =>
  (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ').trim()

const txContext = expect.objectContaining({ tx: transactionClient })

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  executeRawMock.mockResolvedValue(1)
  claimMock.mockResolvedValue({ count: 1 })
  updateUserMock.mockResolvedValue({})
  transitionCommentsMock.mockResolvedValue([{ id: 7, from: 1 }])
  transitionRatingsMock.mockResolvedValue([{ id: 5, from: 1 }])
  transitionResourcesMock.mockResolvedValue([{ id: 8, from: 3 }])
  vi.mocked(deleteFileFromS3).mockResolvedValue(undefined)
  vi.mocked(purgeCloudflareCache).mockResolvedValue({ status: 200 })
  invalidateUnreadMock.mockImplementation(async (uid: number) => {
    events.push(`invalidate-unread:${uid}`)
  })
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      events.push('transaction-start')
      const result = await callback(transactionClient)
      events.push('transaction-commit')
      return result
    }
  )
})

describe('applyModerationVerdict', () => {
  it('locks the user and content rows before claiming the task to keep lock order aligned with delete paths', async () => {
    await expect(
      applyModerationVerdict({ task: ratingTask(), approved: true })
    ).resolves.toBe(true)

    expect(executeRawMock).toHaveBeenCalledTimes(2)
    const userLockSql = joinSql(executeRawMock.mock.calls[0])
    expect(userLockSql).toContain('FROM "user"')
    expect(userLockSql).toContain('FOR KEY SHARE')
    expect(executeRawMock.mock.calls[0][1]).toBe(100)

    const contentLockSql = joinSql(executeRawMock.mock.calls[1])
    expect(contentLockSql).toContain('FROM patch_rating')
    expect(contentLockSql).toContain('FOR UPDATE')
    expect(executeRawMock.mock.calls[1][1]).toBe(5)

    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      executeRawMock.mock.invocationCallOrder[1]
    )
    expect(executeRawMock.mock.invocationCallOrder[1]).toBeLessThan(
      claimMock.mock.invocationCallOrder[0]
    )

    // 认领之后才落定内容: 只从待审核 (1) 转公开 (0)。本条任务已认领, 不作废别的任务
    expect(transitionRatingsMock).toHaveBeenCalledWith(txContext, [5], {
      from: [1],
      to: 0,
      openTasks: 'keep'
    })
    expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(
      transitionRatingsMock.mock.invocationCallOrder[0]
    )
    // 通过不发驳回通知, 不失效作者未读缓存
    expect(events).toEqual(['transaction-start', 'transaction-commit'])
    expect(createMessage).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('does nothing when the claim loses to a concurrent verdict', async () => {
    claimMock.mockResolvedValue({ count: 0 })

    await expect(
      applyModerationVerdict({
        task: ratingTask(),
        approved: false,
        rejectCode: 'ATK'
      })
    ).resolves.toBe(false)

    expect(transitionRatingsMock).not.toHaveBeenCalled()
    expect(createMessage).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('locks the user once with FOR UPDATE for profile verdicts', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({
          content_type: 'bio',
          content_id: null,
          patch_id: null,
          payload: { text: 'new bio', bio: 'new bio' }
        }),
        approved: true
      })
    ).resolves.toBe(true)

    expect(executeRawMock).toHaveBeenCalledTimes(1)
    const userLockSql = joinSql(executeRawMock.mock.calls[0])
    expect(userLockSql).toContain('FROM "user"')
    expect(userLockSql).toContain('FOR UPDATE')
    expect(userLockSql).not.toContain('FOR KEY SHARE')
    expect(executeRawMock.mock.calls[0][1]).toBe(100)
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      claimMock.mock.invocationCallOrder[0]
    )

    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { bio: 'new bio', bio_status: 0 }
    })
  })

  it('skips the content lock for dry-run tasks', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({ dry_run: true }),
        approved: true
      })
    ).resolves.toBe(true)

    expect(executeRawMock).not.toHaveBeenCalled()
    expect(claimMock).toHaveBeenCalledTimes(1)
    expect(transitionRatingsMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('skips the content lock when the verdict defers to manual review', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask(),
        approved: false,
        manual: true
      })
    ).resolves.toBe(true)

    expect(executeRawMock).not.toHaveBeenCalled()
    expect(claimMock).toHaveBeenCalledTimes(1)
    expect(transitionRatingsMock).not.toHaveBeenCalled()
    // 转人工不写驳回通知, 不失效
    expect(createMessage).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('still deletes pending avatar objects when the CDN purge rejects', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    vi.mocked(purgeCloudflareCache).mockRejectedValueOnce(
      new Error('cf unreachable')
    )

    await expect(
      applyModerationVerdict({
        task: ratingTask({
          content_type: 'avatar',
          content_id: null,
          patch_id: null,
          payload: {
            pendingKey: 'avatar/user_100/pending-abc.avif',
            pendingMiniKey: 'avatar/user_100/pending-abc-mini.avif',
            avatarKey: 'avatar/user_100/avatar.avif',
            avatarMiniKey: 'avatar/user_100/avatar-mini.avif',
            avatarLink:
              'https://img.kungal.com/avatar/user_100/avatar-mini.avif?v=1',
            pendingLink:
              'https://img.kungal.com/avatar/user_100/pending-abc-mini.avif?v=1'
          }
        }),
        approved: true
      })
    ).resolves.toBe(true)

    expect(purgeCloudflareCache).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to purge avatar CDN cache:',
      expect.any(Error)
    )
    expect(deleteFileFromS3).toHaveBeenCalledTimes(2)
    expect(deleteFileFromS3).toHaveBeenCalledWith(
      'avatar/user_100/pending-abc.avif'
    )
    expect(deleteFileFromS3).toHaveBeenCalledWith(
      'avatar/user_100/pending-abc-mini.avif'
    )
    consoleErrorSpy.mockRestore()
  })

  it('hides the rejected comment and notifies the author with an appeal link', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({ content_type: 'comment', content_id: 7 }),
        approved: false,
        rejectCode: 'ATK',
        rejectReason: '辱骂他人'
      })
    ).resolves.toBe(true)

    expect(claimMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'rejected',
          reject_code: 'ATK',
          reject_reason: '辱骂他人'
        })
      })
    )
    // 待审核 (1) 的评论: 拒绝转隐藏 (2)
    expect(transitionCommentsMock).toHaveBeenCalledWith(txContext, [7], {
      from: [1],
      to: 2,
      openTasks: 'keep'
    })
    expect(createMessage).toHaveBeenCalledWith(
      {
        type: 'system',
        content: MODERATION_REJECT_NOTICE.comment(),
        link: APPEAL_SETTINGS_LINK,
        recipient_id: 100
      },
      transactionClient
    )
    // 驳回通知写入后, 作者未读缓存在提交后失效 (L-01)
    expect(invalidateUnreadMock).toHaveBeenCalledWith(100)
    expect(events).toEqual([
      'transaction-start',
      'transaction-commit',
      'invalidate-unread:100'
    ])
  })

  // 缓存失效与创建时被拦下的通知的补发, 由迁移命令按「待审 → 公开」登记
  it('moves an approved comment to public through the transition command', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({ content_type: 'comment', content_id: 7 }),
        approved: true
      })
    ).resolves.toBe(true)

    expect(transitionCommentsMock).toHaveBeenCalledWith(txContext, [7], {
      from: [1],
      to: 0,
      openTasks: 'keep'
    })
    expect(createMessage).not.toHaveBeenCalled()
  })

  // 内容已被管理员改过状态或已删除: 任务照常落定, 内容不动
  it('still settles the task when the content already left the pending state', async () => {
    transitionCommentsMock.mockResolvedValue([])

    await expect(
      applyModerationVerdict({
        task: ratingTask({ content_type: 'comment', content_id: 7 }),
        approved: true
      })
    ).resolves.toBe(true)

    expect(claimMock).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['transaction-start', 'transaction-commit'])
  })

  it('falls back to the reject code label when the verdict carries no reason', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({ content_type: 'comment', content_id: 7 }),
        approved: false,
        rejectCode: 'BLK'
      })
    ).resolves.toBe(true)

    expect(claimMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reject_code: 'BLK',
          reject_reason: MODERATION_REJECT_CODE_MAP.BLK
        })
      })
    )
  })

  it('hides the rejected rating and notifies the author', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask(),
        approved: false,
        rejectCode: 'ATK',
        rejectReason: '辱骂他人'
      })
    ).resolves.toBe(true)

    // 待审核 (1) 的评价: 拒绝转隐藏 (2)
    expect(transitionRatingsMock).toHaveBeenCalledWith(txContext, [5], {
      from: [1],
      to: 2,
      openTasks: 'keep'
    })
    expect(events).toEqual([
      'transaction-start',
      'transaction-commit',
      'invalidate-unread:100'
    ])
    expect(createMessage).toHaveBeenCalledWith(
      {
        type: 'system',
        content: MODERATION_REJECT_NOTICE.rating(),
        link: APPEAL_SETTINGS_LINK,
        recipient_id: 100
      },
      transactionClient
    )
  })

  it('hides the rejected resource and notifies the author with the resource name', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({
          content_type: 'resource',
          content_id: 8,
          payload: { text: 'kun', name: '汉化补丁 v1.0' }
        }),
        approved: false,
        rejectCode: 'FEE',
        rejectReason: '违反免费原则'
      })
    ).resolves.toBe(true)

    // 待审核 (3) 的资源: 拒绝转隐藏 (1)。聚合重算、搜索入箱与缓存失效都在迁移命令里
    expect(transitionResourcesMock).toHaveBeenCalledWith(txContext, [8], {
      from: [3],
      to: 1,
      openTasks: 'keep'
    })
    expect(createMessage).toHaveBeenCalledWith(
      {
        type: 'system',
        content: MODERATION_REJECT_NOTICE.resource('汉化补丁 v1.0'),
        link: APPEAL_SETTINGS_LINK,
        recipient_id: 100
      },
      transactionClient
    )
    expect(invalidateUnreadMock).toHaveBeenCalledWith(100)
  })

  it('moves an approved resource to public through the transition command', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({ content_type: 'resource', content_id: 8 }),
        approved: true
      })
    ).resolves.toBe(true)

    expect(transitionResourcesMock).toHaveBeenCalledWith(txContext, [8], {
      from: [3],
      to: 0,
      openTasks: 'keep'
    })
  })

  it('keeps the existing bio and omits the appeal link when a profile verdict rejects', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({
          content_type: 'bio',
          content_id: null,
          patch_id: null,
          payload: { text: 'new bio', bio: 'new bio' }
        }),
        approved: false,
        rejectCode: 'AD'
      })
    ).resolves.toBe(true)

    // 新签名从未落地, 拒绝只清审核标记
    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { bio_status: 0 }
    })
    // avatar / bio 未被应用, 无申诉入口
    expect(createMessage).toHaveBeenCalledWith(
      {
        type: 'system',
        content: MODERATION_REJECT_NOTICE.bio(),
        link: '',
        recipient_id: 100
      },
      transactionClient
    )
  })
})

// 载荷一律经 taskCodec 解码; v2 是引入送审主体之后的落库形状
describe('applyModerationVerdict: 载荷解码', () => {
  it('通过签名任务时写入 v2 载荷里暂存的新签名', async () => {
    await applyModerationVerdict({
      task: ratingTask({
        content_type: 'bio',
        content_id: null,
        patch_id: null,
        payload: {
          v: 2,
          segments: [{ label: '签名', kind: 'plain', value: 'new  bio' }],
          text: 'new bio',
          bio: 'new  bio'
        }
      }),
      approved: true
    })

    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { bio: 'new  bio', bio_status: 0 }
    })
  })

  it('拒绝资源任务时通知里引用 v2 载荷的资源名', async () => {
    await applyModerationVerdict({
      task: ratingTask({
        content_type: 'resource',
        payload: {
          v: 2,
          segments: [{ label: '标题', kind: 'plain', value: 'Patch v1' }],
          text: '标题: Patch v1 介绍:',
          name: 'Patch v1'
        }
      }),
      approved: false,
      rejectCode: 'AD'
    })

    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: MODERATION_REJECT_NOTICE.resource('Patch v1')
      }),
      transactionClient
    )
  })

  // 待生效的新签名只在载荷里: 读不出来还照常通过, 会把用户的签名清成空串
  it('签名载荷不可读时拒绝通过, 任务保持未认领', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({
          content_type: 'bio',
          content_id: null,
          patch_id: null,
          payload: { v: 2, segments: 'broken', bio: 'new bio' }
        }),
        approved: true,
        fromStatus: 'manual'
      })
    ).rejects.toThrow('载荷无法解析')

    expect(claimMock).not.toHaveBeenCalled()
    expect(updateUserMock).not.toHaveBeenCalled()
  })

  it('签名载荷不可读时仍可拒绝: 清审核标记, 保留原签名', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({
          content_type: 'bio',
          content_id: null,
          patch_id: null,
          payload: { v: 2, segments: 'broken', bio: 'new bio' }
        }),
        approved: false,
        fromStatus: 'manual'
      })
    ).resolves.toBe(true)

    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { bio_status: 0 }
    })
  })

  it('头像载荷不可读时拒绝通过, 任务保持未认领', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({
          content_type: 'avatar',
          content_id: null,
          patch_id: null,
          payload: { pendingLink: 'https://img.kungal.com/only-this.avif' }
        }),
        approved: true
      })
    ).rejects.toThrow('载荷无法解析')

    expect(copyObject).not.toHaveBeenCalled()
    expect(claimMock).not.toHaveBeenCalled()
  })

  // 否则这条任务与用户的「头像审核中」标记永远清不掉
  it('头像载荷不可读时仍可拒绝: 清审核标记, 不碰 S3', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({
          content_type: 'avatar',
          content_id: null,
          patch_id: null,
          payload: { pendingLink: 'https://img.kungal.com/only-this.avif' }
        }),
        approved: false,
        rejectCode: 'SEX',
        fromStatus: 'manual'
      })
    ).resolves.toBe(true)

    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { avatar_status: 0 }
    })
    expect(invalidateUserSession).toHaveBeenCalledWith(100)
    expect(deleteFileFromS3).not.toHaveBeenCalled()
    expect(purgeCloudflareCache).not.toHaveBeenCalled()
  })
})

describe('失败记账留下的痕迹', () => {
  const avatarTask = () =>
    ratingTask({
      content_type: 'avatar',
      content_id: null,
      patch_id: null,
      payload: {
        pendingKey: 'pending.avif',
        pendingMiniKey: 'pending-mini.avif',
        avatarKey: 'avatar.avif',
        avatarMiniKey: 'avatar-mini.avif',
        avatarLink: 'https://img.kungal.com/avatar-mini.avif',
        pendingLink: 'https://img.kungal.com/pending.avif'
      }
    })

  // 之前失败过又终于落定的任务: 类别不清掉, AI 拿不准转人工的任务会被管理端按
  // 「供应商不可用」之类归错类
  it.each([
    ['通过', { approved: true }, 'approved'],
    ['拒绝', { approved: false, rejectCode: 'AD' }, 'rejected'],
    ['AI 拿不准转人工', { approved: true, manual: true }, 'manual']
  ])('裁决落定 (%s) 时清掉失败类别', async (_name, options, status) => {
    await applyModerationVerdict({
      task: ratingTask({ failure_kind: 'unavailable', defer_count: 3 }),
      ...options
    })

    expect(claimMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status, failure_kind: '' })
      })
    )
  })

  it('转人工时写下失败类别与原因, 只动仍在待处理的任务', async () => {
    taskUpdateMock.mockResolvedValue({ count: 1 })

    await markTaskManual(9, {
      kind: 'deferral_exhausted',
      reason: '长'.repeat(600)
    })

    expect(taskUpdateMock).toHaveBeenCalledWith({
      where: { id: 9, status: 'pending' },
      data: {
        status: 'manual',
        failure_kind: 'deferral_exhausted',
        reject_reason: '长'.repeat(500)
      }
    })
  })

  it('重排把两份预算与失败类别一起清零', async () => {
    taskUpdateMock.mockResolvedValue({ count: 1 })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(created)
    try {
      await requeueModerationTask(9)
    } finally {
      vi.useRealTimers()
    }

    expect(taskUpdateMock).toHaveBeenCalledWith({
      where: { id: 9, status: 'manual', verdict: { equals: Prisma.DbNull } },
      data: {
        status: 'pending',
        retry: 0,
        defer_count: 0,
        failure_kind: '',
        next_attempt: created,
        picked_at: null,
        reject_reason: ''
      }
    })
  })

  // worker 靠范围决定这次失败算谁的: 存储的错误必须在这里说清, 不能以裸的 SDK 错误出去
  it('头像落地时存储不可用: 以带范围的 DependencyFailure 抛出, 任务不认领', async () => {
    vi.mocked(copyObject).mockRejectedValueOnce(
      Object.assign(new Error('Service Unavailable'), {
        $fault: 'server',
        $metadata: { httpStatusCode: 503 }
      })
    )

    const error = await applyModerationVerdict({
      task: avatarTask(),
      approved: true
    }).then(
      () => null,
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(DependencyFailure)
    expect(error).toMatchObject({
      dependency: 's3',
      scope: 'transient',
      status: 503
    })
    expect(claimMock).not.toHaveBeenCalled()
  })

  // worker 在作业关停的宽限期满时中止: 两次复制都不再等到各自的 60 秒超时
  it('头像落地的两次复制都跟着调用方的 signal 中止', async () => {
    vi.mocked(copyObject).mockClear()
    const controller = new AbortController()

    await applyModerationVerdict({
      task: avatarTask(),
      approved: true,
      signal: controller.signal
    })
    controller.abort()

    const signals = vi
      .mocked(copyObject)
      .mock.calls.map(([, , signal]) => signal as AbortSignal)
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })
})
