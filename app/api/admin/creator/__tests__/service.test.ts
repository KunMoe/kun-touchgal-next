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

import { getAdminCreator } from '~/app/api/admin/creator/service'

describe('getAdminCreator', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    findManyMock.mockResolvedValue([])
    countMock.mockResolvedValue(0)
  })

  it('申请列表按 created 再按 id 倒序分页', async () => {
    const result = await getAdminCreator({ page: 2, limit: 30 })

    // 同毫秒并列行只按 created 排序时 skip/take 会跨页重复或丢失, 须带 id 决胜
    expect(findManyMock.mock.calls[0][0]).toEqual({
      where: { type: 'apply', sender_id: { not: null } },
      take: 30,
      skip: 30,
      orderBy: [{ created: 'desc' }, { id: 'desc' }],
      include: {
        sender: { include: { _count: { select: { patch_resource: true } } } }
      }
    })
    expect(result).toEqual({ creators: [], total: 0 })
  })
})
