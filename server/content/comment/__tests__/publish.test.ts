import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)
const { invalidateUnreadMock, reserveAbuseBudgetMock } = vi.hoisted(() => ({
  invalidateUnreadMock: vi.fn(),
  reserveAbuseBudgetMock: vi.fn()
}))

vi.mock('~/prisma/index', () => rec.module)
vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))
vi.mock('~/server/abuse/budget', () => ({
  reserveAbuseBudget: reserveAbuseBudgetMock
}))

import {
  onCommentPublished,
  planCommentNotifications
} from '~/server/content/comment/publish'
import type { CommentNotificationSubject } from '~/server/content/comment/publish'

const subject = (
  overrides: Partial<CommentNotificationSubject> = {}
): CommentNotificationSubject => ({
  id: 11,
  content: 'comment',
  authorId: 7,
  authorName: 'kun',
  patchName: '游戏名',
  patchUniqueId: 'patch-10',
  resourceId: null,
  parent: null,
  resourceOwnerId: null,
  ...overrides
})

// 三类通知的文案在这里逐字钉住: 它们曾在 create.ts 与 apply.ts 各有一份,
// 靠注释要求「逐字一致」
describe('planCommentNotifications', () => {
  it('回复通知父评论作者, 引用父评论正文的前 107 字', () => {
    expect(
      planCommentNotifications(
        subject({ parent: { authorId: 9, content: 'p'.repeat(200) } })
      )
    ).toEqual([
      {
        type: 'comment',
        content: `回复了您的评论：${'p'.repeat(107)}`,
        sender_id: 7,
        recipient_id: 9,
        link: '/patch-10?tab=comments&commentId=11'
      }
    ])
  })

  it('资源的一级评论通知上传者, 引用评论正文的前 107 字, 深链到资源页', () => {
    expect(
      planCommentNotifications(
        subject({
          content: 'c'.repeat(200),
          resourceId: 5,
          resourceOwnerId: 3
        })
      )
    ).toEqual([
      {
        type: 'comment',
        content: `评论了您发布的资源：${'c'.repeat(107)}`,
        sender_id: 7,
        recipient_id: 3,
        link: '/patch-10/resource/5?commentId=11'
      }
    ])
  })

  it('资源评论的回复只通知父评论作者, 不通知上传者', () => {
    expect(
      planCommentNotifications(
        subject({
          resourceId: 42,
          resourceOwnerId: 3,
          parent: { authorId: 9, content: 'parent' }
        })
      )
    ).toEqual([
      {
        type: 'comment',
        content: '回复了您的评论：parent',
        sender_id: 7,
        recipient_id: 9,
        link: '/patch-10/resource/42?commentId=11'
      }
    ])
  })

  it('提及通知带评论者与游戏名, 正文取纯文本的前 50 字', () => {
    const content = `[@a](/user/5/comment) ${'字'.repeat(80)}`

    const [mention] = planCommentNotifications(subject({ content }))

    expect(mention).toEqual({
      type: 'mention',
      content: `kun 在「游戏名」的评论区提到了您\n${`@a ${'字'.repeat(80)}`.slice(0, 50)}`,
      sender_id: 7,
      recipient_id: 5,
      link: '/patch-10?tab=comments&commentId=11'
    })
  })

  it('同一评论重复提及同一用户只通知一次, 不通知自己', () => {
    const planned = planCommentNotifications(
      subject({
        content:
          '[@a](/user/5/comment) 再喊一次 [@a](/user/5/comment) [@me](/user/7/comment)'
      })
    )

    expect(planned.map((item) => [item.type, item.recipient_id])).toEqual([
      ['mention', 5]
    ])
  })

  it('回复自己的评论、评论自己上传的资源都不通知', () => {
    expect(
      planCommentNotifications(
        subject({ parent: { authorId: 7, content: 'parent' } })
      )
    ).toEqual([])
    expect(
      planCommentNotifications(subject({ resourceId: 5, resourceOwnerId: 7 }))
    ).toEqual([])
  })

  it('被回复的人同时被提及时两类通知各发一条', () => {
    const planned = planCommentNotifications(
      subject({
        content: '[@p](/user/9/comment) 你好',
        parent: { authorId: 9, content: 'parent' }
      })
    )

    expect(planned.map((item) => [item.type, item.recipient_id])).toEqual([
      ['comment', 9],
      ['mention', 9]
    ])
  })
})

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 11,
  content: 'comment',
  user_id: 7,
  resource_id: null,
  patch: { name: '游戏名', unique_id: 'patch-10' },
  user: { name: 'kun', role: 1 },
  parent: null,
  resource: null,
  ...overrides
})

const outsideLabels = () => rec.outside.map((item) => item.label)
const created = () =>
  rec.outside
    .filter((item) => item.label === 'user_message.createMany')
    .map((item) => (item.args as { data: unknown[] }).data)

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
  rec.on('user.findMany', (args: { where: { id: { in: number[] } } }) =>
    args.where.id.in.map((id) => ({ id }))
  )
  rec.on('user_message.findMany', [])
  reserveAbuseBudgetMock.mockResolvedValue(null)
})

describe('onCommentPublished', () => {
  it('评论已不存在时什么都不做', async () => {
    rec.on('patch_comment.findUnique', null)

    await onCommentPublished(11)

    expect(outsideLabels()).toEqual(['patch_comment.findUnique'])
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('没有要通知的人时不查重也不写入', async () => {
    rec.on('patch_comment.findUnique', row())

    await onCommentPublished(11)

    expect(outsideLabels()).toEqual(['patch_comment.findUnique'])
  })

  it('写入通知后才失效收件人的未读缓存, 每人一次', async () => {
    rec.on(
      'patch_comment.findUnique',
      row({
        content: '[@p](/user/9/comment) 你好',
        parent: { user_id: 9, content: 'parent' }
      })
    )
    const order: string[] = []
    rec.on('user_message.createMany', () => {
      order.push('createMany')
      return { count: 2 }
    })
    invalidateUnreadMock.mockImplementation(async (uid: number) => {
      order.push(`invalidate:${uid}`)
    })

    await onCommentPublished(11)

    expect(created()).toEqual([
      [
        expect.objectContaining({ type: 'comment', recipient_id: 9 }),
        expect.objectContaining({ type: 'mention', recipient_id: 9 })
      ]
    ])
    expect(order).toEqual(['createMany', 'invalidate:9'])
  })

  // 同一条评论会多次变为公开: 编辑后重审通过、隐藏后恢复。回复通知的正文引用父评论,
  // 父评论被编辑后正文不同, 按全字段比对就会再发一条
  it('三类通知都按 (type, sender, recipient, link) 去重, 不比对正文', async () => {
    rec.on(
      'patch_comment.findUnique',
      row({
        content: '[@a](/user/5/comment) [@b](/user/6/comment)',
        parent: { user_id: 9, content: '编辑后的父评论' }
      })
    )
    rec.on('user_message.findMany', [
      { type: 'comment', recipient_id: 9 },
      { type: 'mention', recipient_id: 5 }
    ])

    await onCommentPublished(11)

    expect(
      rec.outside.find((item) => item.label === 'user_message.findMany')?.args
    ).toEqual({
      where: {
        type: { in: ['comment', 'mention'] },
        sender_id: 7,
        recipient_id: { in: [9, 5, 6] },
        link: '/patch-10?tab=comments&commentId=11'
      },
      select: { type: true, recipient_id: true }
    })
    expect(created()).toEqual([
      [expect.objectContaining({ type: 'mention', recipient_id: 6 })]
    ])
    expect(invalidateUnreadMock.mock.calls).toEqual([[6]])
  })

  it('已全部通知过时不再写入', async () => {
    rec.on(
      'patch_comment.findUnique',
      row({ resource_id: 5, resource: { user_id: 3 } })
    )
    rec.on('user_message.findMany', [{ type: 'comment', recipient_id: 3 }])

    await onCommentPublished(11)

    expect(created()).toEqual([])
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  // 提及的 uid 取自正文, 可以是任意数字; 不过滤的话 createMany 撞外键, 整批通知都发不出去
  it('提及了不存在的用户时跳过它, 其余通知照发', async () => {
    rec.on(
      'patch_comment.findUnique',
      row({
        content: '[@ghost](/user/404/comment) [@a](/user/5/comment)',
        parent: { user_id: 9, content: 'parent' }
      })
    )
    rec.on('user.findMany', [{ id: 5 }])

    await onCommentPublished(11)

    expect(
      rec.outside.find((item) => item.label === 'user.findMany')?.args
    ).toEqual({ where: { id: { in: [404, 5] } }, select: { id: true } })
    expect(created()).toEqual([
      [
        expect.objectContaining({ type: 'comment', recipient_id: 9 }),
        expect.objectContaining({ type: 'mention', recipient_id: 5 })
      ]
    ])
  })

  // 提及跨评论无界: 每一轮 (即时发布、审核通过后的补发、编辑后重审) 按真正新增的收件人计费
  it('只按去重、剔除不存在的用户之后新增的提及收件人向评论者计费', async () => {
    rec.on(
      'patch_comment.findUnique',
      row({
        content:
          '[@a](/user/5/comment) [@b](/user/6/comment) [@ghost](/user/404/comment)',
        parent: { user_id: 9, content: 'parent' }
      })
    )
    rec.on('user.findMany', [{ id: 5 }, { id: 6 }])
    rec.on('user_message.findMany', [{ type: 'mention', recipient_id: 5 }])

    await onCommentPublished(11)

    expect(reserveAbuseBudgetMock).toHaveBeenCalledExactlyOnceWith(
      [{ policy: 'notify.mention', cost: 1 }],
      { uid: 7, role: 1 }
    )
    expect(created()).toEqual([
      [
        expect.objectContaining({ type: 'comment', recipient_id: 9 }),
        expect.objectContaining({ type: 'mention', recipient_id: 6 })
      ]
    ])
  })

  it('没有新增的提及时不计费', async () => {
    rec.on(
      'patch_comment.findUnique',
      row({ parent: { user_id: 9, content: 'parent' } })
    )

    await onCommentPublished(11)

    expect(reserveAbuseBudgetMock).not.toHaveBeenCalled()
    expect(created()).toHaveLength(1)
  })

  it('提及超出预算时这一轮的提及整批不发、记 warn, 回复通知照发', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reserveAbuseBudgetMock.mockResolvedValue({
      policy: 'notify.mention',
      per: 'uid',
      retryAfterSec: 3600
    })
    rec.on(
      'patch_comment.findUnique',
      row({
        content: '[@a](/user/5/comment) [@b](/user/6/comment)',
        parent: { user_id: 9, content: 'parent' }
      })
    )

    await onCommentPublished(11)

    expect(created()).toEqual([
      [expect.objectContaining({ type: 'comment', recipient_id: 9 })]
    ])
    expect(invalidateUnreadMock.mock.calls).toEqual([[9]])
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it('提及超出预算且没有别的通知时什么都不写', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reserveAbuseBudgetMock.mockResolvedValue({
      policy: 'notify.mention',
      per: 'uid',
      retryAfterSec: 3600
    })
    rec.on(
      'patch_comment.findUnique',
      row({ content: '[@a](/user/5/comment)' })
    )

    await onCommentPublished(11)

    expect(created()).toEqual([])
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('写入失败只记日志, 不向调用方抛错', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('fk violation')
    rec.on(
      'patch_comment.findUnique',
      row({ parent: { user_id: 9, content: 'parent' } })
    )
    rec.on('user_message.createMany', () => {
      throw failure
    })

    await expect(onCommentPublished(11)).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledWith('评论 11 的通知发送失败:', failure)
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
