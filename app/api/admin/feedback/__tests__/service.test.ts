import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, countMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user_message: {
      findMany: findManyMock,
      count: countMock
    }
  }
}))

import { getFeedback } from '~/app/api/admin/feedback/service'

describe('getFeedback', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    findManyMock.mockResolvedValue([])
    countMock.mockResolvedValue(0)
  })

  it('反馈列表按 created 再按 id 倒序分页', async () => {
    const result = await getFeedback({ page: 2, limit: 30 })

    // 同毫秒并列行只按 created 排序时 skip/take 会跨页重复或丢失, 须带 id 决胜
    expect(findManyMock.mock.calls[0][0]).toEqual({
      where: { type: 'feedback', sender_id: { not: null } },
      include: { sender: { select: { id: true, name: true, avatar: true } } },
      orderBy: [{ created: 'desc' }, { id: 'desc' }],
      skip: 30,
      take: 30
    })
    expect(result).toEqual({ feedbacks: [], total: 0 })
  })
})
