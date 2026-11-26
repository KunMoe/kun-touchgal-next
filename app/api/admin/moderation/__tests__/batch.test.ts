import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kunParsePutBodyMock,
  verifyHeaderCookieMock,
  findAdminMock,
  findTasksMock,
  createAdminLogMock,
  applyVerdictMock,
  requeueMock
} = vi.hoisted(() => ({
  kunParsePutBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  findAdminMock: vi.fn(),
  findTasksMock: vi.fn(),
  createAdminLogMock: vi.fn(),
  applyVerdictMock: vi.fn(),
  requeueMock: vi.fn()
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePutBody: kunParsePutBodyMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: { findUnique: findAdminMock },
    moderation_task: { findMany: findTasksMock },
    admin_log: { create: createAdminLogMock }
  }
}))

vi.mock('~/server/moderation/apply', () => ({
  applyModerationVerdict: applyVerdictMock,
  requeueModerationTask: requeueMock
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { PUT } from '~/app/api/admin/moderation/batch/route'
import { kunLog } from '~/lib/log.server'

const request = new Request('http://localhost/api/admin/moderation/batch', {
  method: 'PUT'
}) as unknown as Parameters<typeof PUT>[0]

const task = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  status: 'pending',
  content_type: 'comment',
  content_id: id,
  user_id: 7,
  verdict: null,
  dry_run: false,
  payload: { text: 'hello' },
  ...overrides
})

describe('PUT /admin/moderation/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyHeaderCookieMock.mockResolvedValue({ uid: 1, role: 4 })
    findAdminMock.mockResolvedValue({ id: 1, name: 'kun' })
    createAdminLogMock.mockResolvedValue({})
    applyVerdictMock.mockResolvedValue(true)
    requeueMock.mockResolvedValue({ count: 1 })
  })

  it('rejects non super admins', async () => {
    kunParsePutBodyMock.mockResolvedValue({ taskIds: [1], action: 'approve' })
    verifyHeaderCookieMock.mockResolvedValue({ uid: 1, role: 3 })

    const res = await PUT(request)

    expect(await res.json()).toBe('本页面仅超级管理员可访问')
    expect(applyVerdictMock).not.toHaveBeenCalled()
  })

  it('applies the verdict per task and writes one aggregated admin log', async () => {
    kunParsePutBodyMock.mockResolvedValue({
      taskIds: [1, 2],
      action: 'approve'
    })
    findTasksMock.mockResolvedValue([task(1), task(2, { status: 'manual' })])

    const res = await PUT(request)

    expect(await res.json()).toEqual({ success: 2, failedIds: [] })
    expect(applyVerdictMock).toHaveBeenCalledTimes(2)
    expect(applyVerdictMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ approved: true, fromStatus: 'manual' })
    )
    expect(createAdminLogMock).toHaveBeenCalledTimes(1)
  })

  it('deduplicates taskIds so a repeated id is only applied once', async () => {
    kunParsePutBodyMock.mockResolvedValue({
      taskIds: [1, 1, 1],
      action: 'reject'
    })
    findTasksMock.mockResolvedValue([task(1)])

    const res = await PUT(request)

    expect(await res.json()).toEqual({ success: 1, failedIds: [] })
    expect(applyVerdictMock).toHaveBeenCalledTimes(1)
  })

  it('keeps going when one task throws and reports it as failed', async () => {
    kunParsePutBodyMock.mockResolvedValue({
      taskIds: [1, 2],
      action: 'approve'
    })
    findTasksMock.mockResolvedValue([task(1), task(2)])
    const error = new Error('S3 timeout')
    applyVerdictMock.mockRejectedValueOnce(error).mockResolvedValueOnce(true)

    const res = await PUT(request)

    expect(await res.json()).toEqual({ success: 1, failedIds: [1] })
    expect(applyVerdictMock).toHaveBeenCalledTimes(2)
    expect(kunLog).toHaveBeenCalledTimes(1)
    expect(kunLog).toHaveBeenCalledWith(
      'admin.batch_item_failed',
      { kind: 'moderation', action: 'approve', id: 1 },
      error
    )
  })

  it('skips tasks that already left pending / manual', async () => {
    kunParsePutBodyMock.mockResolvedValue({
      taskIds: [1, 2],
      action: 'approve'
    })
    findTasksMock.mockResolvedValue([task(1, { status: 'approved' }), task(2)])

    const res = await PUT(request)

    expect(await res.json()).toEqual({ success: 1, failedIds: [1] })
    expect(applyVerdictMock).toHaveBeenCalledTimes(1)
  })

  it('skips missing tasks without writing a log when nothing succeeded', async () => {
    kunParsePutBodyMock.mockResolvedValue({ taskIds: [9], action: 'approve' })
    findTasksMock.mockResolvedValue([])

    const res = await PUT(request)

    expect(await res.json()).toEqual({ success: 0, failedIds: [9] })
    expect(createAdminLogMock).not.toHaveBeenCalled()
  })

  it('retries only manual tasks without an AI verdict', async () => {
    kunParsePutBodyMock.mockResolvedValue({
      taskIds: [1, 2, 3],
      action: 'retry'
    })
    findTasksMock.mockResolvedValue([
      task(1, { status: 'manual' }),
      task(2, { status: 'manual', verdict: { p: 0 } }),
      task(3, { status: 'pending' })
    ])

    const res = await PUT(request)

    expect(await res.json()).toEqual({ success: 1, failedIds: [2, 3] })
    expect(requeueMock).toHaveBeenCalledExactlyOnceWith(1)
    expect(applyVerdictMock).not.toHaveBeenCalled()
  })

  it('lets the claim guard absorb a stale verdict race without a pre-filter', async () => {
    // 客户端已不过滤: 选中集原样提交, 服务端仅对快照里 verdict 非空的剔除;
    // 快照后到落库前被 worker 写入 verdict 的任务, 由 requeue 的认领守卫
    // (verdict: DbNull) 以 count 0 兜住, 计为失败而非静默放行
    kunParsePutBodyMock.mockResolvedValue({ taskIds: [1], action: 'retry' })
    findTasksMock.mockResolvedValue([task(1, { status: 'manual' })])
    requeueMock.mockResolvedValue({ count: 0 })

    const res = await PUT(request)

    expect(await res.json()).toEqual({ success: 0, failedIds: [1] })
  })
})
