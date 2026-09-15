import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_BLOCKED_TAG_IDS } from '~/utils/blockedTag'

const {
  verifyHeaderCookieMock,
  userFindUniqueMock,
  userUpdateMock,
  patchTagFindUniqueMock,
  invalidateUserSessionMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userUpdateMock: vi.fn(),
  patchTagFindUniqueMock: vi.fn(),
  invalidateUserSessionMock: vi.fn()
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
    user: {
      findUnique: userFindUniqueMock,
      update: userUpdateMock
    },
    patch_tag: {
      findUnique: patchTagFindUniqueMock
    }
  }
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

import { POST } from '~/app/api/user/setting/blocked-tag/route'

const range = (length: number, from = 1) =>
  Array.from({ length }, (_, index) => index + from)

const createRequest = (tagId: number) =>
  new Request('http://localhost/api/user/setting/blocked-tag', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tagId })
  }) as unknown as Parameters<typeof POST>[0]

const givenBlockedTagIds = (ids: number[]) => {
  userFindUniqueMock.mockResolvedValue({ blocked_tag_ids: ids })
}

beforeEach(() => {
  verifyHeaderCookieMock.mockReset()
  userFindUniqueMock.mockReset()
  userUpdateMock.mockReset()
  patchTagFindUniqueMock.mockReset()
  invalidateUserSessionMock.mockReset()

  verifyHeaderCookieMock.mockResolvedValue({ uid: 7 })
  patchTagFindUniqueMock.mockImplementation(async ({ where }) => ({
    id: where.id
  }))
  userUpdateMock.mockImplementation(async ({ data }) => ({
    blocked_tag_ids: data.blocked_tag_ids.set
  }))
  invalidateUserSessionMock.mockResolvedValue(undefined)
})

describe('POST /api/user/setting/blocked-tag', () => {
  // 上限缺席时 DB 数组可无界增长, 与镜像 cookie 的截断上限分叉
  it('屏蔽数已达上限时拒绝新标签且不写库', async () => {
    givenBlockedTagIds(range(MAX_BLOCKED_TAG_IDS))

    const response = await POST(createRequest(MAX_BLOCKED_TAG_IDS + 1))
    const body = await response.json()

    expect(body).toBe(`最多只能屏蔽 ${MAX_BLOCKED_TAG_IDS} 个标签`)
    expect(userUpdateMock).not.toHaveBeenCalled()
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })

  // 闸门若写成 >= 或前置于 append, 满额用户重屏蔽已有标签会被误拒
  it('满额时重复屏蔽已在列表中的标签仍然成功', async () => {
    givenBlockedTagIds(range(MAX_BLOCKED_TAG_IDS))

    const response = await POST(createRequest(1))
    const body = await response.json()

    expect(body).toEqual({ blockedTagIds: range(MAX_BLOCKED_TAG_IDS) })
    expect(userUpdateMock).toHaveBeenCalledTimes(1)
  })

  it('恰好填满上限的那一次屏蔽正常写入', async () => {
    givenBlockedTagIds(range(MAX_BLOCKED_TAG_IDS - 1))

    const response = await POST(createRequest(MAX_BLOCKED_TAG_IDS))
    const body = await response.json()

    expect(body).toEqual({ blockedTagIds: range(MAX_BLOCKED_TAG_IDS) })
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(7)
  })
})
