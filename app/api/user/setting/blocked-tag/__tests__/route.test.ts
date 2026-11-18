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

import { DELETE, POST } from '~/app/api/user/setting/blocked-tag/route'

const range = (length: number, from = 1) =>
  Array.from({ length }, (_, index) => index + from)

const createRequest = (tagId: number) =>
  new Request('http://localhost/api/user/setting/blocked-tag', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tagId })
  }) as unknown as Parameters<typeof POST>[0]

const createDeleteRequest = (tagId: number) =>
  new Request(`http://localhost/api/user/setting/blocked-tag?tagId=${tagId}`, {
    method: 'DELETE'
  }) as unknown as Parameters<typeof DELETE>[0]

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

// 服务端的屏蔽列表只取鉴权结果 (库或鉴权缓存), 不再有 cookie 副本垫着:
// 写库之后不让鉴权缓存失效, 屏蔽与取消屏蔽就要等缓存过期才生效
describe('屏蔽列表改动后让鉴权缓存失效', () => {
  it('屏蔽: 先写库, 再失效该用户的鉴权缓存', async () => {
    givenBlockedTagIds([1, 2])

    const response = await POST(createRequest(3))

    expect(await response.json()).toEqual({ blockedTagIds: [1, 2, 3] })
    expect(invalidateUserSessionMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(7)
    expect(userUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateUserSessionMock.mock.invocationCallOrder[0]
    )
  })

  it('取消屏蔽: 先写库, 再失效该用户的鉴权缓存', async () => {
    givenBlockedTagIds([1, 2, 3])

    const response = await DELETE(createDeleteRequest(2))

    expect(await response.json()).toEqual({ blockedTagIds: [1, 3] })
    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { blocked_tag_ids: { set: [1, 3] } }
      })
    )
    expect(invalidateUserSessionMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(7)
    expect(userUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateUserSessionMock.mock.invocationCallOrder[0]
    )
  })

  it('未登录时不写库也不动缓存', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    const response = await DELETE(createDeleteRequest(2))

    expect(await response.json()).toBe('用户未登录')
    expect(userUpdateMock).not.toHaveBeenCalled()
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })
})
