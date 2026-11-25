import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getKvMock,
  evalKvScriptMock,
  messageFindFirstMock,
  conversationFindFirstMock,
  recordOutcomeMock
} = vi.hoisted(() => ({
  getKvMock: vi.fn(),
  evalKvScriptMock: vi.fn(),
  messageFindFirstMock: vi.fn(),
  conversationFindFirstMock: vi.fn(),
  recordOutcomeMock: vi.fn()
}))

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  evalKvScript: evalKvScriptMock
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
    evalKvScriptMock.mockResolvedValue(1)
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
    expect(evalKvScriptMock).not.toHaveBeenCalled()
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
    // 写回经「只让更新的条目写进去」的脚本, 带上快照的时刻 (契约见 cache.redis.test.ts)
    expect(evalKvScriptMock).toHaveBeenCalledWith(
      expect.stringContaining('cjson.decode'),
      [CACHE_KEY],
      [JSON.stringify(status), 5000, 30, 0]
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

  it('reads an invalidation tombstone as a miss', async () => {
    getKvMock.mockResolvedValue(JSON.stringify({ invalidated: true, asOf: 7 }))

    await getUnreadMessageStatus(UID)

    expect(messageFindFirstMock).toHaveBeenCalledTimes(1)
    expect(recordedOutcomes()).toEqual([['message:unread', 'miss']])
  })
})

describe('invalidateUnread', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    evalKvScriptMock.mockResolvedValue(1)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // 删键挡不住「查询早于写入提交、晚于失效才写回」的旧值: 键没了它照样写进去
  it('writes a tombstone stamped with the invalidation time instead of deleting', async () => {
    vi.useFakeTimers({ now: 4242 })

    await invalidateUnread(UID)

    expect(evalKvScriptMock).toHaveBeenCalledWith(
      expect.stringContaining('cjson.decode'),
      [CACHE_KEY],
      [JSON.stringify({ invalidated: true, asOf: 4242 }), 4242, 30, 1]
    )
  })

  it('swallows redis failures', async () => {
    evalKvScriptMock.mockRejectedValue(new Error('redis down'))

    await expect(invalidateUnread(UID)).resolves.toBeUndefined()
  })
})
