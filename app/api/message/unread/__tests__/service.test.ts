import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getKvMock,
  setKvMock,
  delKvMock,
  messageFindFirstMock,
  conversationFindFirstMock,
  recordOutcomeMock
} = vi.hoisted(() => ({
  getKvMock: vi.fn(),
  setKvMock: vi.fn(),
  delKvMock: vi.fn(),
  messageFindFirstMock: vi.fn(),
  conversationFindFirstMock: vi.fn(),
  recordOutcomeMock: vi.fn()
}))

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  setKv: setKvMock,
  delKv: delKvMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user_message: { findFirst: messageFindFirstMock },
    user_conversation: { findFirst: conversationFindFirstMock }
  }
}))

vi.mock('~/server/cache/stats', () => ({
  kunRecordCacheOutcome: recordOutcomeMock
}))

import { getUnreadMessageStatus } from '~/app/api/message/unread/service'
import { invalidateUnread } from '~/app/api/message/unread/cache'

const UID = 42
const CACHE_KEY = `message:unread:${UID}`

const recordedOutcomes = () =>
  recordOutcomeMock.mock.calls.map((call) => [call[0], call[1]])

describe('getUnreadMessageStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setKvMock.mockResolvedValue(undefined)
    delKvMock.mockResolvedValue(undefined)
    messageFindFirstMock.mockResolvedValue(null)
    conversationFindFirstMock.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns cached status without querying postgres', async () => {
    getKvMock.mockResolvedValue(
      JSON.stringify({
        hasUnreadNotification: true,
        hasUnreadConversation: false,
        asOf: 1234
      })
    )

    const status = await getUnreadMessageStatus(UID)

    // 命中缓存时的时刻是算出那份快照的时刻, 不是这次读到它的时刻
    expect(status).toEqual({
      hasUnreadNotification: true,
      hasUnreadConversation: false,
      asOf: 1234
    })
    expect(messageFindFirstMock).not.toHaveBeenCalled()
    expect(conversationFindFirstMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(recordedOutcomes()).toEqual([['message:unread', 'hit']])
  })

  it('caches written before snapshots carried a time read as the oldest', async () => {
    getKvMock.mockResolvedValue(
      JSON.stringify({
        hasUnreadNotification: false,
        hasUnreadConversation: true
      })
    )

    expect(await getUnreadMessageStatus(UID)).toEqual({
      hasUnreadNotification: false,
      hasUnreadConversation: true,
      asOf: 0
    })
  })

  it('queries postgres and writes through on cache miss', async () => {
    vi.useFakeTimers({ now: 5000 })
    getKvMock.mockResolvedValue(null)
    // 时刻取在查询开始之前: 查询期间时钟走了也不变
    messageFindFirstMock.mockImplementation(async () => {
      vi.setSystemTime(9000)
      return { id: 1 }
    })
    conversationFindFirstMock.mockResolvedValue(null)

    const status = await getUnreadMessageStatus(UID)

    expect(status).toEqual({
      hasUnreadNotification: true,
      hasUnreadConversation: false,
      asOf: 5000
    })
    expect(messageFindFirstMock).toHaveBeenCalledTimes(1)
    expect(conversationFindFirstMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).toHaveBeenCalledWith(
      CACHE_KEY,
      JSON.stringify(status),
      30
    )
    expect(recordedOutcomes()).toEqual([['message:unread', 'miss']])
  })

  it('falls back to postgres when the cache read throws', async () => {
    getKvMock.mockRejectedValue(new Error('redis down'))

    const status = await getUnreadMessageStatus(UID)

    expect(status).toMatchObject({
      hasUnreadNotification: false,
      hasUnreadConversation: false
    })
    expect(messageFindFirstMock).toHaveBeenCalledTimes(1)
    expect(recordedOutcomes()).toEqual([['message:unread', 'degraded']])
  })

  it('ignores malformed cached payloads and re-queries', async () => {
    getKvMock.mockResolvedValue('not-json')

    await getUnreadMessageStatus(UID)

    expect(messageFindFirstMock).toHaveBeenCalledTimes(1)
  })
})

describe('invalidateUnread', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delKvMock.mockResolvedValue(undefined)
  })

  it('deletes the per-user unread cache key', async () => {
    await invalidateUnread(UID)

    expect(delKvMock).toHaveBeenCalledWith(CACHE_KEY)
  })
})
