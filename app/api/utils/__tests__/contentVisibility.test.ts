import { beforeEach, describe, expect, it, vi } from 'vitest'

const { hasPendingResourceMock } = vi.hoisted(() => ({
  hasPendingResourceMock: vi.fn()
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  hasPendingResource: hasPendingResourceMock
}))

import {
  getCommentRatingVisibilityWhere,
  getCommentVisibilitySql,
  getListResourceStatusWhere,
  getResourceVisibilityWhere,
  isContentVisibleToViewer,
  shouldBypassSharedCache
} from '~/app/api/utils/contentVisibility'

describe('shouldBypassSharedCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false for anonymous without checking pending resources', async () => {
    const result = await shouldBypassSharedCache(null)

    expect(result).toBe(false)
    expect(hasPendingResourceMock).not.toHaveBeenCalled()
  })

  it('returns true for admin without checking pending resources', async () => {
    const result = await shouldBypassSharedCache({ uid: 7, role: 3 })

    expect(result).toBe(true)
    expect(hasPendingResourceMock).not.toHaveBeenCalled()
  })

  it('delegates to hasPendingResource for authenticated non-admins', async () => {
    hasPendingResourceMock.mockResolvedValue(true)

    const result = await shouldBypassSharedCache({ uid: 7, role: 1 })

    expect(result).toBe(true)
    expect(hasPendingResourceMock).toHaveBeenCalledWith(7)
  })

  it('does not bypass when the author has no pending resource', async () => {
    hasPendingResourceMock.mockResolvedValue(false)

    const result = await shouldBypassSharedCache({ uid: 7, role: 1 })

    expect(result).toBe(false)
    expect(hasPendingResourceMock).toHaveBeenCalledWith(7)
  })
})

// content.viewPending 的边界: 创作者 (role 2) 与普通用户同视角, 只看得到自己的待审内容;
// 管理员 (role 3) 起才看得到他人的待审内容
describe('getListResourceStatusWhere', () => {
  const visibility = { contentLimit: 'sfw', blockedTagIds: [] } as const

  it('shared 与 filtered 视角只看公开资源', () => {
    expect(getListResourceStatusWhere({ kind: 'shared', visibility })).toEqual({
      status: 0
    })
    expect(
      getListResourceStatusWhere({
        kind: 'filtered',
        visibility: { contentLimit: 'sfw', blockedTagIds: [1] }
      })
    ).toEqual({ status: 0 })
  })

  it('personal 视角按 viewer 取: 作者看到自己待审核的, 管理员看到全部待审核的', () => {
    expect(
      getListResourceStatusWhere({
        kind: 'personal',
        visibility,
        viewer: { uid: 7, role: 2 }
      })
    ).toEqual({
      OR: [{ status: 0 }, { status: { in: [2, 3] }, user_id: 7 }]
    })
    expect(
      getListResourceStatusWhere({
        kind: 'personal',
        visibility,
        viewer: { uid: 7, role: 3 }
      })
    ).toEqual({ status: { in: [0, 2, 3] } })
  })
})

describe('待审内容可见性的角色边界 (content.viewPending)', () => {
  const OTHER_UID = 99

  beforeEach(() => {
    vi.resetAllMocks()
  })

  it.each([1, 2])('role %i 看不到他人的待审内容', (role) => {
    const viewer = { uid: 7, role }

    expect(isContentVisibleToViewer(viewer, OTHER_UID)).toBe(false)
    expect(isContentVisibleToViewer(viewer, 7)).toBe(true)
    expect(getCommentRatingVisibilityWhere(viewer)).toEqual({
      OR: [{ status: 0 }, { status: 1, user_id: 7 }]
    })
    expect(getResourceVisibilityWhere(viewer)).toEqual({
      OR: [{ status: 0 }, { status: { in: [2, 3] }, user_id: 7 }]
    })
    const sql = getCommentVisibilitySql(viewer)
    expect(sql.sql).toBe('(status = 0 OR (status = 1 AND user_id = ?))')
    expect(sql.values).toEqual([7])
  })

  it.each([3, 4])('role %i 看得到他人的待审内容', (role) => {
    const viewer = { uid: 7, role }

    expect(isContentVisibleToViewer(viewer, OTHER_UID)).toBe(true)
    expect(getCommentRatingVisibilityWhere(viewer)).toEqual({
      status: { in: [0, 1] }
    })
    expect(getResourceVisibilityWhere(viewer)).toEqual({
      status: { in: [0, 2, 3] }
    })
    const sql = getCommentVisibilitySql(viewer)
    expect(sql.sql).toBe('status IN (0, 1)')
    expect(sql.values).toEqual([])
  })

  it('role 2 没有待审资源时不绕过共享缓存', async () => {
    hasPendingResourceMock.mockResolvedValue(false)

    const result = await shouldBypassSharedCache({ uid: 7, role: 2 })

    expect(result).toBe(false)
    expect(hasPendingResourceMock).toHaveBeenCalledWith(7)
  })
})
