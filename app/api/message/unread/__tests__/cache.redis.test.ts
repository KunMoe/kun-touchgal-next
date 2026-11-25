import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import {
  contractSubjectId,
  openRedisContract,
  redisContractUrl
} from '~/lib/__tests__/redisContract'
import type { RedisContract } from '~/lib/__tests__/redisContract'

// 未读缓存「只让更新的条目写进去」在真 Redis 上的语义 (运行方式见 lib/__tests__/redisContract.ts)。
// 防的是回填竞态: 查询早于某次写入提交的请求, 晚于那次失效才把结果写回缓存, 30 秒内刷新、
// 新标签页都会读回写入之前的未读状态 (11-26 T37 复核探针复现过)

describe.skipIf(!redisContractUrl)('unread cache on real Redis', () => {
  let kv: RedisContract
  let cache: typeof import('~/app/api/message/unread/cache')
  let uids: number[] = []

  beforeAll(async () => {
    kv = await openRedisContract()
    cache = await import('~/app/api/message/unread/cache')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (uids.length) {
      await kv.del(...uids.map((uid) => `message:unread:${uid}`))
    }
    uids = []
  })

  afterAll(() => {
    kv?.close()
  })

  const newUid = () => {
    const uid = contractSubjectId()
    uids.push(uid)
    return uid
  }
  const snapshot = (asOf: number, unread: boolean) => ({
    hasUnreadNotification: unread,
    hasUnreadConversation: false,
    asOf
  })

  it('更旧的快照写不进去, 更新的照常覆盖, 并带 30 秒 TTL', async () => {
    const uid = newUid()
    await cache.setCachedUnread(uid, snapshot(100, true))
    await cache.setCachedUnread(uid, snapshot(90, false))
    expect(await cache.getCachedUnread(uid)).toEqual(snapshot(100, true))

    await cache.setCachedUnread(uid, snapshot(100, false))
    expect(await cache.getCachedUnread(uid)).toEqual(snapshot(100, true))

    await cache.setCachedUnread(uid, snapshot(110, false))
    expect(await cache.getCachedUnread(uid)).toEqual(snapshot(110, false))
    expect(await kv.ttl(`message:unread:${uid}`)).toBeGreaterThan(25)
  })

  // 已读接口提交并失效 (墓碑), 之后一个查询更早开始的请求才写回: 写不进去
  it('失效之后, 查询早于失效的快照写不回来; 之后读作未命中', async () => {
    const uid = newUid()
    await cache.setCachedUnread(uid, snapshot(100, true))
    const before = Date.now() - 1

    await cache.invalidateUnread(uid)
    expect(await cache.getCachedUnread(uid)).toBeNull()

    await cache.setCachedUnread(uid, snapshot(before, true))
    expect(await cache.getCachedUnread(uid)).toBeNull()

    const tombstone = JSON.parse((await kv.get(`message:unread:${uid}`))!)
    expect(tombstone).toMatchObject({ invalidated: true })
    // 同一毫秒算出的快照也不收: 它的查询可能早于失效
    await cache.setCachedUnread(uid, snapshot(tombstone.asOf, true))
    expect(await cache.getCachedUnread(uid)).toBeNull()

    await cache.setCachedUnread(uid, snapshot(tombstone.asOf + 1, false))
    expect(await cache.getCachedUnread(uid)).toEqual(
      snapshot(tombstone.asOf + 1, false)
    )
  })

  // 与失效同一毫秒算出的快照可能早于那次写入的提交: 失效要盖掉它
  it('同一毫秒的已存快照被失效盖掉', async () => {
    const uid = newUid()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await cache.setCachedUnread(uid, snapshot(now, true))

    await cache.invalidateUnread(uid)

    expect(await cache.getCachedUnread(uid)).toBeNull()
  })

  // 快照晚于失效算出, 已经反映了那次写入: 失效不该把它冲掉
  it('早于已存快照的失效不覆盖它', async () => {
    const uid = newUid()
    const future = Date.now() + 60_000
    await cache.setCachedUnread(uid, snapshot(future, false))

    await cache.invalidateUnread(uid)

    expect(await cache.getCachedUnread(uid)).toEqual(snapshot(future, false))
  })

  it('没有时刻的旧条目与解析不了的值都直接覆盖', async () => {
    const legacy = newUid()
    await kv.set(
      `message:unread:${legacy}`,
      JSON.stringify({
        hasUnreadNotification: true,
        hasUnreadConversation: true
      })
    )
    expect(await cache.getCachedUnread(legacy)).toEqual({
      hasUnreadNotification: true,
      hasUnreadConversation: true,
      asOf: 0
    })
    await cache.setCachedUnread(legacy, snapshot(1, false))
    expect(await cache.getCachedUnread(legacy)).toEqual(snapshot(1, false))

    const broken = newUid()
    await kv.set(`message:unread:${broken}`, 'not-json')
    await cache.setCachedUnread(broken, snapshot(1, true))
    expect(await cache.getCachedUnread(broken)).toEqual(snapshot(1, true))
  })
})
