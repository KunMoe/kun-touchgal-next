import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  verifyHeaderCookieMock,
  queryRawMock,
  getUnreadMessageStatusMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  queryRawMock: vi.fn(),
  getUnreadMessageStatusMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
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
  prisma: { $queryRaw: queryRawMock }
}))

vi.mock('../../unread/service', () => ({
  getUnreadMessageStatus: getUnreadMessageStatusMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

import { PUT } from '~/app/api/message/read/route'

const UID = 7

describe('message/read PUT', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyHeaderCookieMock.mockResolvedValue({ uid: UID })
    queryRawMock.mockResolvedValue([{ count: 0 }])
    invalidateUnreadMock.mockResolvedValue(undefined)
    getUnreadMessageStatusMock.mockResolvedValue({
      hasUnreadNotification: false,
      hasUnreadConversation: false
    })
  })

  it('invalidates the unread cache before recomputing status', async () => {
    const res = await PUT({} as never)

    expect(invalidateUnreadMock).toHaveBeenCalledWith(UID)
    expect(getUnreadMessageStatusMock).toHaveBeenCalledWith(UID)
    expect(invalidateUnreadMock.mock.invocationCallOrder[0]).toBeLessThan(
      getUnreadMessageStatusMock.mock.invocationCallOrder[0]
    )
    expect(await res.json()).toEqual({
      hasUnreadNotification: false,
      hasUnreadConversation: false
    })
  })

  it('does not touch the cache when unauthenticated', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    await PUT({} as never)

    expect(invalidateUnreadMock).not.toHaveBeenCalled()
    expect(getUnreadMessageStatusMock).not.toHaveBeenCalled()
  })
  it('writes the read timestamp as a utc wall clock', async () => {
    await PUT({} as never)

    const sql = (queryRawMock.mock.calls[0][0] as TemplateStringsArray)
      .join('?')
      .replace(/\s+/g, ' ')
    expect(sql).toContain("updated = now() AT TIME ZONE 'UTC'")
    expect(sql).not.toMatch(/now\(\)(?!\s+AT TIME ZONE)/i)
  })
})
