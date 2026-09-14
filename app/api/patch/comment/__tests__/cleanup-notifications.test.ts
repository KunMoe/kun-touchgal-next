import { beforeEach, describe, expect, it, vi } from 'vitest'

import { cleanupCommentNotifications } from '~/app/api/patch/comment/notifications'

type CommentRow = {
  id: number
  user_id: number
  parent_id: number | null
  resource_id: number | null
  parent: { user_id: number } | null
  resource: { user_id: number } | null
  patch: { unique_id: string }
}

const makeRow = (overrides: Partial<CommentRow> = {}): CommentRow => ({
  id: 11,
  user_id: 7,
  parent_id: null,
  resource_id: null,
  parent: null,
  resource: null,
  patch: { unique_id: 'patch-10' },
  ...overrides
})

const makeTx = (rows: CommentRow[]) => ({
  patch_comment: { findMany: vi.fn().mockResolvedValue(rows) },
  user_message: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) }
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('cleanupCommentNotifications', () => {
  it('顶层普通评论也清理点赞与提及: like 锚 recipient=作者, mention 锚 sender=作者', async () => {
    const tx = makeTx([makeRow()])

    await cleanupCommentNotifications(tx as never, [11])

    expect(tx.user_message.deleteMany).toHaveBeenCalledTimes(2)
    expect(tx.user_message.deleteMany).toHaveBeenNthCalledWith(1, {
      where: {
        type: { in: ['comment', 'like'] },
        recipient_id: { in: [7] },
        link: { in: ['/patch-10?tab=comments&commentId=11'] }
      }
    })
    expect(tx.user_message.deleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        type: 'mention',
        sender_id: { in: [7] },
        link: { in: ['/patch-10?tab=comments&commentId=11'] }
      }
    })
  })

  it('资源评论子树: recipient 含各行作者+上传者+父作者, sender 含各行作者', async () => {
    const tx = makeTx([
      makeRow({ resource_id: 5, resource: { user_id: 3 } }),
      makeRow({
        id: 12,
        user_id: 9,
        parent_id: 11,
        parent: { user_id: 7 },
        resource_id: 5,
        resource: { user_id: 3 }
      })
    ])

    await cleanupCommentNotifications(tx as never, [11, 12])

    const links = [
      '/patch-10/resource/5?commentId=11',
      '/patch-10/resource/5?commentId=12'
    ]
    expect(tx.patch_comment.findMany).toHaveBeenCalledTimes(1)
    expect(tx.patch_comment.findMany).toHaveBeenCalledWith({
      where: { id: { in: [11, 12] } },
      select: {
        id: true,
        user_id: true,
        parent_id: true,
        resource_id: true,
        parent: { select: { user_id: true } },
        resource: { select: { user_id: true } },
        patch: { select: { unique_id: true } }
      }
    })
    expect(tx.user_message.deleteMany).toHaveBeenNthCalledWith(1, {
      where: {
        type: { in: ['comment', 'like'] },
        recipient_id: { in: [7, 3, 9] },
        link: { in: links }
      }
    })
    expect(tx.user_message.deleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        type: 'mention',
        sender_id: { in: [7, 9] },
        link: { in: links }
      }
    })
  })

  it('跨补丁批量: unique_id 与 resource_id 均按行取', async () => {
    const tx = makeTx([
      makeRow(),
      makeRow({
        id: 21,
        user_id: 9,
        resource_id: 42,
        resource: { user_id: 3 },
        patch: { unique_id: 'patch-20' }
      })
    ])

    await cleanupCommentNotifications(tx as never, [11, 21])

    const links = [
      '/patch-10?tab=comments&commentId=11',
      '/patch-20/resource/42?commentId=21'
    ]
    expect(tx.user_message.deleteMany).toHaveBeenNthCalledWith(1, {
      where: {
        type: { in: ['comment', 'like'] },
        recipient_id: { in: [7, 9, 3] },
        link: { in: links }
      }
    })
    expect(tx.user_message.deleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        type: 'mention',
        sender_id: { in: [7, 9] },
        link: { in: links }
      }
    })
  })

  it('查不到评论行 (id 集合为空 / 行已被并发删除) 时不发删除语句', async () => {
    const tx = makeTx([])

    await cleanupCommentNotifications(tx as never, [11])

    expect(tx.patch_comment.findMany).toHaveBeenCalledTimes(1)
    expect(tx.user_message.deleteMany).not.toHaveBeenCalled()
  })
})
