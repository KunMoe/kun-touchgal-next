import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

const {
  parsePostMock,
  parsePutMock,
  verifyHeaderCookieMock,
  patchFindUniqueMock,
  transactionMock,
  relationFindManyMock,
  relationCreateManyMock,
  relationDeleteManyMock,
  enqueueOutboxMock,
  queueSearchSyncMock,
  invalidateListCacheMock,
  invalidateContentCacheMock,
  tx
} = vi.hoisted(() => {
  const relationFindManyMock = vi.fn()
  const relationCreateManyMock = vi.fn()
  const relationDeleteManyMock = vi.fn()
  return {
    parsePostMock: vi.fn(),
    parsePutMock: vi.fn(),
    verifyHeaderCookieMock: vi.fn(),
    patchFindUniqueMock: vi.fn(),
    transactionMock: vi.fn(),
    relationFindManyMock,
    relationCreateManyMock,
    relationDeleteManyMock,
    enqueueOutboxMock: vi.fn(),
    queueSearchSyncMock: vi.fn(),
    invalidateListCacheMock: vi.fn(),
    invalidateContentCacheMock: vi.fn(),
    tx: {
      patch_tag_relation: {
        findMany: relationFindManyMock,
        createMany: relationCreateManyMock,
        deleteMany: relationDeleteManyMock
      }
    }
  }
})

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePostBody: parsePostMock,
  kunParsePutBody: parsePutMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma', () => ({
  prisma: {
    patch: { findUnique: patchFindUniqueMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: enqueueOutboxMock,
  queueSearchSync: queueSearchSyncMock
}))

vi.mock('~/app/api/tag/cache', () => ({
  invalidateTagListCache: invalidateListCacheMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidateContentCacheMock
}))

import { POST, PUT } from '~/app/api/patch/introduction/tag/route'

const INPUT = { patchId: 42, tagId: [7, 8] }
const UNIQUE_ID = 'abcd1234'
const request = new Request('http://localhost') as unknown as Parameters<
  typeof POST
>[0]

type RouteHandler = typeof POST

beforeEach(() => {
  vi.resetAllMocks()
  parsePostMock.mockResolvedValue(INPUT)
  parsePutMock.mockResolvedValue(INPUT)
  verifyHeaderCookieMock.mockResolvedValue({ uid: 1, role: 3 })
  patchFindUniqueMock.mockResolvedValue({ unique_id: UNIQUE_ID })
  transactionMock.mockImplementation(
    async (fn: (client: typeof tx) => unknown) => fn(tx)
  )
  relationFindManyMock.mockResolvedValue([])
  relationCreateManyMock.mockResolvedValue({ count: 2 })
  relationDeleteManyMock.mockResolvedValue({ count: 2 })
  enqueueOutboxMock.mockResolvedValue(undefined)
  invalidateListCacheMock.mockResolvedValue(undefined)
  invalidateContentCacheMock.mockResolvedValue(undefined)
})

// 与 company 侧同一套编排契约: 抽 helper 后两边共用一份实现,
// 任一路由的鉴权/404/失效顺序漂移都会在这里变红
const describeOrchestrationContract = (
  label: string,
  handler: RouteHandler,
  parseMock: Mock,
  makeChanged: () => void,
  makeUnchanged: () => void
) => {
  describe(`${label} 公共编排`, () => {
    it('解析失败直接回错误串, 不查补丁', async () => {
      parseMock.mockResolvedValue('标签 ID 必须为数字')
      const res = await handler(request)
      expect(await res.json()).toBe('标签 ID 必须为数字')
      // 解析必须先于鉴权: 否则未登录用户提交非法 body 会收到'用户未登录'而非校验消息
      expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
      expect(patchFindUniqueMock).not.toHaveBeenCalled()
    })

    it('未登录返回 用户未登录', async () => {
      verifyHeaderCookieMock.mockResolvedValue(null)
      const res = await handler(request)
      expect(await res.json()).toBe('用户未登录')
      expect(patchFindUniqueMock).not.toHaveBeenCalled()
    })

    it('role 低于 3 返回管理员提示', async () => {
      verifyHeaderCookieMock.mockResolvedValue({ uid: 1, role: 2 })
      const res = await handler(request)
      expect(await res.json()).toBe('本页面仅管理员可访问')
      expect(transactionMock).not.toHaveBeenCalled()
    })

    it('补丁不存在返回 未找到 Galgame, 不进事务', async () => {
      patchFindUniqueMock.mockResolvedValue(null)
      const res = await handler(request)
      expect(await res.json()).toBe('未找到 Galgame')
      expect(transactionMock).not.toHaveBeenCalled()
    })

    it('有变更时失效两处缓存并触发搜索同步', async () => {
      makeChanged()
      const res = await handler(request)
      expect(await res.json()).toEqual({})
      expect(patchFindUniqueMock).toHaveBeenCalledWith({
        where: { id: INPUT.patchId },
        select: { unique_id: true }
      })
      expect(invalidateListCacheMock).toHaveBeenCalledTimes(1)
      expect(queueSearchSyncMock).toHaveBeenCalledWith(INPUT.patchId)
      expect(invalidateContentCacheMock).toHaveBeenCalledWith(UNIQUE_ID)
    })

    it('无变更时三处缓存均不失效, 也不入搜索出箱', async () => {
      makeUnchanged()
      const res = await handler(request)
      expect(await res.json()).toEqual({})
      expect(invalidateListCacheMock).not.toHaveBeenCalled()
      expect(queueSearchSyncMock).not.toHaveBeenCalled()
      expect(invalidateContentCacheMock).not.toHaveBeenCalled()
      expect(enqueueOutboxMock).not.toHaveBeenCalled()
    })

    it('详情缓存失效抛错不影响返回', async () => {
      makeChanged()
      invalidateContentCacheMock.mockRejectedValue(new Error('redis down'))
      const res = await handler(request)
      expect(await res.json()).toEqual({})
    })
  })
}

describeOrchestrationContract(
  'POST',
  POST,
  parsePostMock,
  () => relationFindManyMock.mockResolvedValue([]),
  () => relationFindManyMock.mockResolvedValue([{ tag_id: 7 }, { tag_id: 8 }])
)

describeOrchestrationContract(
  'PUT',
  PUT,
  parsePutMock,
  () => relationFindManyMock.mockResolvedValue([{ tag_id: 7 }, { tag_id: 8 }]),
  () => relationFindManyMock.mockResolvedValue([])
)

describe('标签关联事务体', () => {
  it('POST 只新增尚未关联的标签并事务内入队', async () => {
    relationFindManyMock.mockResolvedValue([{ tag_id: 7 }])
    await POST(request)
    expect(relationCreateManyMock).toHaveBeenCalledWith({
      data: [{ patch_id: 42, tag_id: 8 }]
    })
    expect(relationDeleteManyMock).not.toHaveBeenCalled()
    expect(enqueueOutboxMock).toHaveBeenCalledWith(tx, 42)
  })

  it('PUT 只删除确实存在的关联并事务内入队', async () => {
    relationFindManyMock.mockResolvedValue([{ tag_id: 8 }])
    await PUT(request)
    expect(relationDeleteManyMock).toHaveBeenCalledWith({
      where: { patch_id: 42, tag_id: { in: [8] } }
    })
    expect(relationCreateManyMock).not.toHaveBeenCalled()
    expect(enqueueOutboxMock).toHaveBeenCalledWith(tx, 42)
  })
})
