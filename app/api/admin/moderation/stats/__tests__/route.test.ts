import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  verifyHeaderCookieMock,
  countMock,
  groupByMock,
  aggregateMock,
  readHealthMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  countMock: vi.fn(),
  groupByMock: vi.fn(),
  aggregateMock: vi.fn(),
  readHealthMock: vi.fn()
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    moderation_task: {
      count: countMock,
      groupBy: groupByMock,
      aggregate: aggregateMock
    }
  }
}))

vi.mock('~/server/moderation/health', () => ({
  readModerationHealth: readHealthMock
}))

import { GET } from '~/app/api/admin/moderation/stats/route'

const request = new Request('http://localhost/api/admin/moderation/stats', {
  headers: { cookie: 'kun-galgame-patch-moe-token=token' }
}) as unknown as Parameters<typeof GET>[0]

const health = {
  at: 1,
  mode: 'enforce',
  lanes: {
    text: {
      state: 'open',
      reason: 'misconfigured',
      since: 1,
      openUntil: 2,
      opens: 1,
      lastError: 'status 401'
    },
    avatar: {
      state: 'closed',
      reason: null,
      since: null,
      openUntil: null,
      opens: 0,
      lastError: ''
    }
  }
}

const oldest = new Date('2026-11-20T08:00:00.000Z')

describe('GET /admin/moderation/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyHeaderCookieMock.mockResolvedValue({ uid: 1, role: 4 })
    countMock.mockResolvedValue(12)
    groupByMock.mockImplementation(async ({ by }: { by: string[] }) =>
      by[0] === 'status'
        ? [
            { status: 'approved', _count: { _all: 9 } },
            { status: 'manual', _count: { _all: 3 } }
          ]
        : [
            { failure_kind: 'unavailable', _count: { _all: 2 } },
            { failure_kind: '', _count: { _all: 1 } }
          ]
    )
    aggregateMock.mockImplementation(async ({ _sum }: { _sum?: unknown }) =>
      _sum
        ? { _sum: { tokens_in: 100, tokens_out: 20 } }
        : { _min: { created: oldest } }
    )
    readHealthMock.mockResolvedValue(health)
  })

  it('带上车道状态、最早一条待审核任务的时间与转人工的原因分布', async () => {
    const response = await GET(request, { params: Promise.resolve({}) })

    expect(await response.json()).toEqual({
      todayTotal: 12,
      statusCounts: { approved: 9, manual: 3 },
      tokensIn: 100,
      tokensOut: 20,
      worker: health,
      oldestPendingAt: oldest.toISOString(),
      // 空串: AI 拿不准转人工的, 没有失败类别
      manualKindCounts: { unavailable: 2, '': 1 }
    })
  })

  // 挂着的任务不能被 30 天窗口截掉: 积压最久的恰恰是最该被看到的
  it('积压与转人工的统计不限时间窗口, 只按状态取', async () => {
    await GET(request, { params: Promise.resolve({}) })

    expect(aggregateMock).toHaveBeenCalledWith({
      where: { status: 'pending' },
      _min: { created: true }
    })
    expect(groupByMock).toHaveBeenCalledWith({
      by: ['failure_kind'],
      where: { status: 'manual' },
      _count: { _all: true }
    })
  })

  it('worker 没有上报、队列为空时都是 null', async () => {
    readHealthMock.mockResolvedValue(null)
    aggregateMock.mockImplementation(async ({ _sum }: { _sum?: unknown }) =>
      _sum
        ? { _sum: { tokens_in: null, tokens_out: null } }
        : { _min: { created: null } }
    )

    const response = await GET(request, { params: Promise.resolve({}) })

    expect(await response.json()).toMatchObject({
      worker: null,
      oldestPendingAt: null,
      tokensIn: 0,
      tokensOut: 0
    })
  })
})
