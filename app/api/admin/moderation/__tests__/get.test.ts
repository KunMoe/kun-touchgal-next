import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findTasksMock, countMock, findPatchesMock, findCommentsMock } =
  vi.hoisted(() => ({
    findTasksMock: vi.fn(),
    countMock: vi.fn(),
    findPatchesMock: vi.fn(),
    findCommentsMock: vi.fn()
  }))

vi.mock('~/prisma/index', () => ({
  prisma: {
    moderation_task: { findMany: findTasksMock, count: countMock },
    patch: { findMany: findPatchesMock },
    patch_comment: { findMany: findCommentsMock }
  }
}))

import { getModerationTasks } from '~/app/api/admin/moderation/get'

const input = { page: 1, limit: 30, status: 'all' as const }

const baseTask = {
  id: 1,
  content_type: 'comment',
  content_id: null as number | null,
  patch_id: null as number | null,
  status: 'pending',
  reject_code: '',
  reject_reason: '',
  payload: { text: 'hello' },
  verdict: null,
  model: '',
  tokens_in: 0,
  tokens_out: 0,
  retry: 0,
  dry_run: false,
  user: { id: 7, name: 'kun', avatar: '' },
  created: new Date('2026-07-18T00:00:00Z'),
  reviewed: null
}

describe('getModerationTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    countMock.mockResolvedValue(1)
    findPatchesMock.mockResolvedValue([])
    findCommentsMock.mockResolvedValue([])
  })

  it('resolves patch via patch_id for rating / resource tasks', async () => {
    findTasksMock.mockResolvedValue([
      {
        ...baseTask,
        content_type: 'rating',
        content_id: 11,
        patch_id: 3
      }
    ])
    findPatchesMock.mockResolvedValue([
      { id: 3, name: 'Gal A', unique_id: 'abcd1234' }
    ])

    const { tasks } = await getModerationTasks(input)

    expect(findPatchesMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [3] } } })
    )
    expect(tasks[0].patch).toEqual({ uniqueId: 'abcd1234', name: 'Gal A' })
    expect(findCommentsMock).not.toHaveBeenCalled()
  })

  it('resolves patch via patch_comment for comment tasks', async () => {
    findTasksMock.mockResolvedValue([
      { ...baseTask, content_type: 'comment', content_id: 21 }
    ])
    findCommentsMock.mockResolvedValue([
      { id: 21, patch: { name: 'Gal B', unique_id: 'efgh5678' } }
    ])

    const { tasks } = await getModerationTasks(input)

    expect(findCommentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [21] } } })
    )
    expect(tasks[0].patch).toEqual({ uniqueId: 'efgh5678', name: 'Gal B' })
    expect(findPatchesMock).not.toHaveBeenCalled()
  })

  it('returns null patch for user-level tasks and deleted comments', async () => {
    findTasksMock.mockResolvedValue([
      { ...baseTask, id: 1, content_type: 'avatar' },
      // 评论已删除, patch_comment 反查无结果
      { ...baseTask, id: 2, content_type: 'comment', content_id: 99 }
    ])

    const { tasks } = await getModerationTasks(input)

    expect(tasks[0].patch).toBeNull()
    expect(tasks[1].patch).toBeNull()
  })

  it('文本任务下发用户提交的原文: 单段就是那段文字, 多段逐行带字段名', async () => {
    findTasksMock.mockResolvedValue([
      {
        ...baseTask,
        payload: {
          v: 2,
          segments: [
            {
              label: '评论',
              kind: 'markdown-comment',
              value: '看这里 <加群 987654321>'
            }
          ]
        }
      },
      {
        ...baseTask,
        id: 2,
        content_type: 'resource',
        payload: {
          v: 2,
          segments: [
            { label: '标题', kind: 'plain', value: 'Patch <v1>' },
            {
              label: '介绍',
              kind: 'markdown-standard',
              value: '第一行\n第二行'
            }
          ],
          // 过渡期双写的降噪文本, 不再展示
          text: '标题: Patch 介绍: 第一行 第二行',
          name: 'Patch <v1>'
        }
      },
      {
        ...baseTask,
        id: 3,
        content_type: 'bio',
        payload: {
          v: 2,
          segments: [{ label: '签名', kind: 'plain', value: '签 名' }],
          bio: '签 名'
        }
      }
    ])

    const { tasks } = await getModerationTasks(input)

    expect(tasks.map((task) => task.payload)).toEqual([
      { text: '看这里 <加群 987654321>' },
      { text: '标题: Patch <v1>\n介绍: 第一行\n第二行', name: 'Patch <v1>' },
      { text: '签 名', bio: '签 名' }
    ])
  })

  it('引入主体之前的旧任务只有降噪后的平铺文本, 原样展示', async () => {
    findTasksMock.mockResolvedValue([
      { ...baseTask, payload: { text: 'hello' } },
      {
        ...baseTask,
        id: 2,
        content_type: 'resource',
        payload: { text: '标题: A 介绍: B', name: 'A' }
      },
      { ...baseTask, id: 3, payload: {} }
    ])

    const { tasks } = await getModerationTasks(input)

    expect(tasks.map((task) => task.payload)).toEqual([
      { text: 'hello' },
      { text: '标题: A 介绍: B', name: 'A' },
      { text: '' }
    ])
  })

  it('头像任务只下发待审与留档链接, 不带对象 key', async () => {
    findTasksMock.mockResolvedValue([
      {
        ...baseTask,
        content_type: 'avatar',
        payload: {
          pendingKey: 'k1',
          pendingMiniKey: 'k2',
          avatarKey: 'k3',
          avatarMiniKey: 'k4',
          avatarLink: 'https://img.example/avatar.avif',
          pendingLink: 'https://img.example/pending.avif',
          archiveLink: 'https://img.example/archive.avif'
        }
      }
    ])

    const { tasks } = await getModerationTasks(input)

    expect(tasks[0].payload).toEqual({
      pendingLink: 'https://img.example/pending.avif',
      archiveLink: 'https://img.example/archive.avif'
    })
  })

  // 不带 text: 卡片显示「(无文本)」, 也不会出现能把占位文字加进黑名单的按钮
  it('解不出来的载荷不带任何文本, 不让整页失败', async () => {
    findTasksMock.mockResolvedValue([
      { ...baseTask, payload: { v: 2, segments: 'broken' } },
      { ...baseTask, id: 2, content_type: 'avatar', payload: null }
    ])

    const { tasks } = await getModerationTasks(input)

    expect(tasks.map((task) => task.payload)).toEqual([{}, {}])
  })
})
