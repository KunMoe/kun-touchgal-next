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

import { getMessage } from '~/app/api/message/all/service'

const senderInclude = {
  sender: { select: { id: true, name: true, avatar: true } }
}
// 同毫秒写入的并列行只按 created 排序时页间顺序不稳定 (skip/take 会跨页
// 重复或丢失), 须带 id 决胜列, 与 (recipient_id[, type], created DESC, id DESC)
// 复合索引及 conversation 消息分页对齐
const orderBy = [{ created: 'desc' }, { id: 'desc' }]

describe('getMessage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    findManyMock.mockResolvedValue([])
    countMock.mockResolvedValue(0)
  })

  it('不带 type 时按 created 再按 id 倒序分页', async () => {
    const result = await getMessage({ page: 2, limit: 30 }, 1)

    expect(findManyMock).toHaveBeenCalledTimes(1)
    expect(findManyMock.mock.calls[0][0]).toEqual({
      where: { recipient_id: 1 },
      include: senderInclude,
      orderBy,
      skip: 30,
      take: 30
    })
    expect(countMock).toHaveBeenCalledWith({ where: { recipient_id: 1 } })
    expect(result).toEqual({ messages: [], total: 0 })
  })

  it('带 type 时 where 含 type 且排序键不变', async () => {
    await getMessage({ type: 'mention', page: 1, limit: 30 }, 1)

    expect(findManyMock.mock.calls[0][0]).toEqual({
      where: { recipient_id: 1, type: 'mention' },
      include: senderInclude,
      orderBy,
      skip: 0,
      take: 30
    })
  })
})
