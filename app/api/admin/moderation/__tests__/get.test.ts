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

  it('载荷经解码后只下发展示字段: 文本任务给 text / name / bio', async () => {
    findTasksMock.mockResolvedValue([
      { ...baseTask, payload: { text: 'hello' } },
      {
        ...baseTask,
        id: 2,
        content_type: 'resource',
        payload: {
          v: 2,
          segments: [{ label: '标题', kind: 'plain', value: 'Patch <v1>' }],
          text: '标题: Patch 介绍:',
          name: 'Patch <v1>'
        }
      },
      {
        ...baseTask,
        id: 3,
        content_type: 'bio',
        payload: { text: '签名', bio: '签 名' }
      }
    ])

    const { tasks } = await getModerationTasks(input)

    expect(tasks.map((task) => task.payload)).toEqual([
      { text: 'hello' },
      { text: '标题: Patch 介绍:', name: 'Patch <v1>' },
      { text: '签名', bio: '签 名' }
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

  it('解不出来的载荷渲染占位, 不让整页失败', async () => {
    findTasksMock.mockResolvedValue([
      { ...baseTask, payload: { v: 2, segments: 'broken' } },
      { ...baseTask, id: 2, content_type: 'avatar', payload: null }
    ])

    const { tasks } = await getModerationTasks(input)

    expect(tasks.map((task) => task.payload)).toEqual([
      { text: '(载荷无法解析)' },
      { text: '(载荷无法解析)' }
    ])
  })
})
