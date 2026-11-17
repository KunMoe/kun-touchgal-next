import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { moderation_taskModel } from '~/prisma/generated/prisma/models'

const {
  transactionMock,
  executeRawMock,
  claimMock,
  findRatingMock,
  updateRatingMock,
  updateCommentMock,
  findCommentMock,
  findResourceMock,
  updateResourceMock,
  updateUserMock,
  recomputeOneMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  executeRawMock: vi.fn(),
  claimMock: vi.fn(),
  findRatingMock: vi.fn(),
  updateRatingMock: vi.fn(),
  updateCommentMock: vi.fn(),
  findCommentMock: vi.fn(),
  findResourceMock: vi.fn(),
  updateResourceMock: vi.fn(),
  updateUserMock: vi.fn(),
  recomputeOneMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

const transactionClient = {
  $executeRaw: executeRawMock,
  moderation_task: { updateMany: claimMock },
  patch_rating: { findUnique: findRatingMock, update: updateRatingMock },
  patch_comment: {
    updateMany: updateCommentMock,
    findUnique: findCommentMock
  },
  patch_resource: { findUnique: findResourceMock, update: updateResourceMock },
  user: { update: updateUserMock }
}

const events: string[] = []

vi.mock('~/prisma/index', () => ({
  prisma: { $transaction: transactionMock }
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: vi.fn()
}))

vi.mock('~/server/content/comment/publish', () => ({
  onCommentPublished: vi.fn()
}))

vi.mock('~/app/api/patch/rating/stat', () => ({
  recomputePatchRatingStat: recomputeOneMock
}))

vi.mock('~/app/api/patch/resource/_helper', () => ({
  recalcPatchType: vi.fn()
}))

vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: vi.fn()
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: vi.fn(),
  invalidatePatchContentCacheByPatchId: vi.fn()
}))

vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: vi.fn()
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

// resource 拒绝路径的这次失效没有 .catch, 不 mock 会真连 Redis 并抛出
vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: vi.fn()
}))

vi.mock('~/server/search/sync', () => ({
  queueSearchSync: vi.fn(),
  enqueueSearchOutbox: vi.fn()
}))

vi.mock('~/app/api/utils/purgeCloudflareCache', () => ({
  purgeCloudflareCache: vi.fn()
}))

vi.mock('~/lib/s3', () => ({
  copyObject: vi.fn(),
  deleteFileFromS3: vi.fn()
}))

import { applyModerationVerdict } from '~/server/moderation/apply'
import { purgeCloudflareCache } from '~/app/api/utils/purgeCloudflareCache'
import { copyObject, deleteFileFromS3 } from '~/lib/s3'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { createMessage } from '~/app/api/utils/message'
import { onCommentPublished } from '~/server/content/comment/publish'
import { recalcPatchType } from '~/app/api/patch/resource/_helper'
import { enqueueSearchOutbox, queueSearchSync } from '~/server/search/sync'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import {
  invalidatePatchContentCache,
  invalidatePatchContentCacheByPatchId
} from '~/app/api/patch/cache'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import { invalidateUserPendingResourceCache } from '~/app/api/utils/pendingResourceCache'
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

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  executeRawMock.mockResolvedValue(1)
  claimMock.mockResolvedValue({ count: 1 })
  findRatingMock.mockResolvedValue({ patch_id: 10, status: 1 })
  updateRatingMock.mockResolvedValue({})
  updateCommentMock.mockResolvedValue({ count: 1 })
  findCommentMock.mockResolvedValue({ patch_id: 10, resource_id: null })
  findResourceMock.mockResolvedValue({ patch_id: 10, status: 3 })
  updateResourceMock.mockResolvedValue({})
  updateUserMock.mockResolvedValue({})
  vi.mocked(recalcPatchType).mockResolvedValue('kun-unique-id')
  // 这两处失效在 apply.ts 里挂了 .catch, mock 必须返回 Promise
  vi.mocked(invalidatePatchContentCache).mockResolvedValue(undefined)
  vi.mocked(invalidatePatchContentCacheByPatchId).mockResolvedValue(undefined)
  vi.mocked(deleteFileFromS3).mockResolvedValue(undefined)
  vi.mocked(purgeCloudflareCache).mockResolvedValue({ status: 200 })
  invalidateUnreadMock.mockImplementation(async (uid: number) => {
    events.push(`invalidate-unread:${uid}`)
  })
  recomputeOneMock.mockImplementation(
    async (_patchId: number, tx: typeof transactionClient) => {
      expect(tx).toBe(transactionClient)
      events.push('recompute')
    }
  )
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

    expect(updateRatingMock).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { status: 0 }
    })
    expect(recomputeOneMock).toHaveBeenCalledWith(10, transactionClient)
    // 通过不发驳回通知, 不失效作者未读缓存
    expect(events).toEqual([
      'transaction-start',
      'recompute',
      'transaction-commit'
    ])
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

    expect(findRatingMock).not.toHaveBeenCalled()
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
    expect(findRatingMock).not.toHaveBeenCalled()
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
    expect(findRatingMock).not.toHaveBeenCalled()
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
    expect(updateCommentMock).toHaveBeenCalledWith({
      where: { id: 7, status: 1 },
      data: { status: 2 }
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
    // 被拒评论不进公开基线: 既不补发创建时被拦下的通知, 也不失效评论缓存
    expect(onCommentPublished).not.toHaveBeenCalled()
    expect(invalidatePatchCommentCache).not.toHaveBeenCalled()
    // 驳回通知写入后, 作者未读缓存在提交后失效 (L-01)
    expect(invalidateUnreadMock).toHaveBeenCalledWith(100)
    expect(events).toEqual([
      'transaction-start',
      'transaction-commit',
      'invalidate-unread:100'
    ])
  })

  it('publishes the approved comment after both caches are invalidated', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask({ content_type: 'comment', content_id: 7 }),
        approved: true
      })
    ).resolves.toBe(true)

    expect(updateCommentMock).toHaveBeenCalledWith({
      where: { id: 7, status: 1 },
      data: { status: 0 }
    })
    expect(invalidatePatchCommentCache).toHaveBeenCalledWith(10)
    expect(invalidatePatchContentCacheByPatchId).toHaveBeenCalledWith(10)
    // 创建时被拦下的通知在这里补发; 排在缓存失效之后, 通知出问题不连累缓存
    expect(onCommentPublished).toHaveBeenCalledWith(7)
    const published = vi.mocked(onCommentPublished).mock.invocationCallOrder[0]
    expect(
      vi.mocked(invalidatePatchCommentCache).mock.invocationCallOrder[0]
    ).toBeLessThan(published)
    expect(
      vi.mocked(invalidatePatchContentCacheByPatchId).mock
        .invocationCallOrder[0]
    ).toBeLessThan(published)
  })

  it('does not publish when the comment already left the pending state', async () => {
    updateCommentMock.mockResolvedValue({ count: 0 })

    await expect(
      applyModerationVerdict({
        task: ratingTask({ content_type: 'comment', content_id: 7 }),
        approved: true
      })
    ).resolves.toBe(true)

    expect(onCommentPublished).not.toHaveBeenCalled()
    expect(invalidatePatchCommentCache).not.toHaveBeenCalled()
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

  it('hides the rejected rating and recomputes the patch rating summary', async () => {
    await expect(
      applyModerationVerdict({
        task: ratingTask(),
        approved: false,
        rejectCode: 'ATK',
        rejectReason: '辱骂他人'
      })
    ).resolves.toBe(true)

    expect(updateRatingMock).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { status: 2 }
    })
    // 被隐藏的评分要退出统计, 拒绝同样得重算并失效详情缓存
    expect(recomputeOneMock).toHaveBeenCalledWith(10, transactionClient)
    expect(invalidatePatchContentCacheByPatchId).toHaveBeenCalledWith(10)
    expect(events).toEqual([
      'transaction-start',
      'recompute',
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

  it('hides the rejected resource and refreshes the caches gating its visibility', async () => {
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

    expect(updateResourceMock).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { status: 1 }
    })
    expect(enqueueSearchOutbox).toHaveBeenCalledWith(transactionClient, 10)
    expect(createMessage).toHaveBeenCalledWith(
      {
        type: 'system',
        content: MODERATION_REJECT_NOTICE.resource('汉化补丁 v1.0'),
        link: APPEAL_SETTINGS_LINK,
        recipient_id: 100
      },
      transactionClient
    )
    expect(queueSearchSync).toHaveBeenCalledWith(10)
    expect(invalidatePatchContentCache).toHaveBeenCalledWith('kun-unique-id')
    expect(invalidateResourceListCache).toHaveBeenCalledTimes(1)
    expect(invalidateUserPendingResourceCache).toHaveBeenCalledWith(100)
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
