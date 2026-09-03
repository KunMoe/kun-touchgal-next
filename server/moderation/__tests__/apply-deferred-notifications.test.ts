import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findUniqueMock,
  createDedupMessageMock,
  createLinkDedupMessageMock,
  createMentionMessageMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  createDedupMessageMock: vi.fn(),
  createLinkDedupMessageMock: vi.fn(),
  createMentionMessageMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: { findUnique: findUniqueMock }
  }
}))

vi.mock('~/app/api/utils/message', () => ({
  createDedupMessage: createDedupMessageMock,
  createLinkDedupMessage: createLinkDedupMessageMock,
  createMessage: vi.fn()
}))

vi.mock('~/app/api/utils/createMentionMessage', () => ({
  createMentionMessage: createMentionMessageMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

vi.mock('~/app/api/patch/rating/stat', () => ({
  recomputePatchRatingStat: vi.fn()
}))

vi.mock('~/app/api/patch/resource/_helper', () => ({
  recalcPatchType: vi.fn()
}))

vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: vi.fn()
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
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

import { sendDeferredCommentNotifications } from '~/server/moderation/apply'

const baseComment = {
  id: 11,
  content: 'comment',
  user_id: 7,
  parent_id: null,
  resource_id: null,
  patch: { name: 'Patch', unique_id: 'patch-10' },
  user: { name: 'user' },
  parent: null,
  resource: null
}

beforeEach(() => {
  vi.clearAllMocks()
  invalidateUnreadMock.mockResolvedValue(undefined)
})

describe('sendDeferredCommentNotifications', () => {
  it('顶层资源评论过审后补发上传者通知 (文案与 create.ts 一致)', async () => {
    findUniqueMock.mockResolvedValue({
      ...baseComment,
      resource_id: 5,
      resource: { user_id: 3 }
    })

    await sendDeferredCommentNotifications(11)

    // 上传者通知走 link 维度去重: 编辑重审通过后 content 变化不应产生第二条通知
    expect(createLinkDedupMessageMock).toHaveBeenCalledWith({
      type: 'comment',
      content: '评论了您发布的资源：comment',
      sender_id: 7,
      recipient_id: 3,
      link: '/patch-10/resource/5?commentId=11'
    })
    expect(createDedupMessageMock).not.toHaveBeenCalled()
    expect(createMentionMessageMock).toHaveBeenCalledWith(
      'patch-10',
      'Patch',
      11,
      7,
      'user',
      'comment',
      5
    )
    // 通知写入后失效上传者未读缓存 (L-01), 顺序在写入之后
    expect(invalidateUnreadMock).toHaveBeenCalledTimes(1)
    expect(invalidateUnreadMock).toHaveBeenCalledWith(3)
    expect(createLinkDedupMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateUnreadMock.mock.invocationCallOrder[0]
    )
  })

  it('自评自己上传的资源不补发通知', async () => {
    findUniqueMock.mockResolvedValue({
      ...baseComment,
      resource_id: 5,
      resource: { user_id: 7 }
    })

    await sendDeferredCommentNotifications(11)

    expect(createLinkDedupMessageMock).not.toHaveBeenCalled()
    expect(createDedupMessageMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('评论不存在时不发通知也不失效缓存', async () => {
    findUniqueMock.mockResolvedValue(null)

    await sendDeferredCommentNotifications(11)

    expect(createLinkDedupMessageMock).not.toHaveBeenCalled()
    expect(createDedupMessageMock).not.toHaveBeenCalled()
    expect(createMentionMessageMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('资源评论的回复补发通知深链到资源页', async () => {
    findUniqueMock.mockResolvedValue({
      ...baseComment,
      parent_id: 6,
      resource_id: 42,
      resource: { user_id: 3 },
      parent: { user_id: 9, content: 'parent' }
    })

    await sendDeferredCommentNotifications(11)

    expect(createDedupMessageMock).toHaveBeenCalledTimes(1)
    expect(createDedupMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient_id: 9,
        link: '/patch-10/resource/42?commentId=11'
      })
    )
    // 回复只通知父评论作者, 上传者 (3) 不通知也不失效
    expect(invalidateUnreadMock).toHaveBeenCalledTimes(1)
    expect(invalidateUnreadMock).toHaveBeenCalledWith(9)
    expect(createDedupMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateUnreadMock.mock.invocationCallOrder[0]
    )
  })

  it('普通评论回复的补发保持游戏页深链 (回归)', async () => {
    findUniqueMock.mockResolvedValue({
      ...baseComment,
      parent_id: 6,
      parent: { user_id: 9, content: 'parent' }
    })

    await sendDeferredCommentNotifications(11)

    expect(createDedupMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient_id: 9,
        link: '/patch-10?tab=comments&commentId=11'
      })
    )
  })
})
