import { beforeEach, describe, expect, it, vi } from 'vitest'

const { kunParsePostBodyMock, verifyHeaderCookieMock, handleReportMock } =
  vi.hoisted(() => ({
    kunParsePostBodyMock: vi.fn(),
    verifyHeaderCookieMock: vi.fn(),
    handleReportMock: vi.fn()
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
  kunParsePostBody: kunParsePostBodyMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/app/api/admin/report/handle/service', () => ({
  handleReport: handleReportMock
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { POST } from '~/app/api/admin/report/handle/batch/route'
import { kunLog } from '~/lib/log.server'

const request = new Request('http://localhost/api/admin/report/handle/batch', {
  method: 'POST'
}) as unknown as Parameters<typeof POST>[0]

beforeEach(() => {
  vi.resetAllMocks()
  kunParsePostBodyMock.mockResolvedValue({
    reportIds: [1, 2],
    action: 'reject',
    content: ''
  })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 99, role: 4 })
  handleReportMock.mockResolvedValue({})
})

describe('POST /api/admin/report/handle/batch', () => {
  it('rejects non super admin without handling anything', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 99, role: 3 })

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('本页面仅超级管理员可访问')
    expect(handleReportMock).not.toHaveBeenCalled()
  })

  it('handles every report and reports success count', async () => {
    kunParsePostBodyMock.mockResolvedValue({
      reportIds: [1, 2, 3],
      action: 'delete',
      content: '违规内容'
    })

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({
      success: 3,
      skipped: 0,
      failedIds: []
    })
    expect(handleReportMock).toHaveBeenCalledTimes(3)
    expect(handleReportMock).toHaveBeenCalledWith(
      { reportId: 1, action: 'delete', content: '违规内容' },
      99
    )
  })

  it('dedupes ids and classifies skipped / failed without aborting the batch', async () => {
    kunParsePostBodyMock.mockResolvedValue({
      reportIds: [1, 2, 2, 3, 4],
      action: 'delete',
      content: ''
    })
    // 同批前面的删除会连带处理同目标举报, 后续命中「已被处理」属预期,
    // 计入 skipped 而非失败; 单条异常只标记该条, 其余照常处理
    handleReportMock.mockImplementation(async ({ reportId }) => {
      if (reportId === 2) {
        return '该举报已被处理'
      }
      if (reportId === 3) {
        throw new Error('boom')
      }
      return {}
    })

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({
      success: 2,
      skipped: 1,
      failedIds: [3]
    })
    expect(handleReportMock).toHaveBeenCalledTimes(4)
    expect(kunLog).toHaveBeenCalledTimes(1)
    expect(kunLog).toHaveBeenCalledWith(
      'admin.batch_item_failed',
      { kind: 'report', action: 'delete', id: 3 },
      expect.objectContaining({ message: 'boom' })
    )
  })
})
