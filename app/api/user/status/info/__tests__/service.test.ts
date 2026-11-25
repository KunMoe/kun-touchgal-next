import { beforeEach, describe, expect, it, vi } from 'vitest'

const { userFindUniqueMock, relationCountMock, followFindUniqueMock } =
  vi.hoisted(() => ({
    userFindUniqueMock: vi.fn(),
    relationCountMock: vi.fn(),
    followFindUniqueMock: vi.fn()
  }))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock },
    user_patch_favorite_folder_relation: { count: relationCountMock },
    user_follow_relation: { findUnique: followFindUniqueMock }
  }
}))

import { getUserProfile } from '~/app/api/user/status/info/service'

const OWNER = 42

const userRow = {
  id: OWNER,
  name: 'kun',
  email: 'kun@example.com',
  avatar: '',
  bio: '',
  role: 1,
  status: 0,
  register_time: new Date('2026-01-01T00:00:00Z'),
  moemoepoint: 7,
  _count: {
    patch_resource: 1,
    patch: 2,
    patch_comment: 3,
    patch_rating: 4,
    follower: 5,
    following: 6
  }
}

const viewer = (uid: number) => ({ uid, role: 1 })

beforeEach(() => {
  vi.resetAllMocks()
  userFindUniqueMock.mockResolvedValue(userRow)
  relationCountMock.mockResolvedValue(9)
  followFindUniqueMock.mockResolvedValue(null)
})

// X15-01: 收藏统计以前不分访问者, 私密收藏夹里的收藏也算进去
describe('收藏计数只含访问者看得到的收藏夹', () => {
  it('他人视角只数公开收藏夹', async () => {
    await getUserProfile({ id: OWNER }, viewer(9))

    expect(relationCountMock).toHaveBeenCalledWith({
      where: { folder: { user_id: OWNER, is_public: true } }
    })
  })

  it('游客与他人同一口径', async () => {
    await getUserProfile({ id: OWNER }, null)

    expect(relationCountMock).toHaveBeenCalledWith({
      where: { folder: { user_id: OWNER, is_public: true } }
    })
  })

  it('本人视角含私密收藏夹', async () => {
    const profile = await getUserProfile({ id: OWNER }, viewer(OWNER))

    expect(relationCountMock).toHaveBeenCalledWith({
      where: { folder: { user_id: OWNER } }
    })
    expect(profile).toMatchObject({ _count: { patch_favorite: 9 } })
  })
})

describe('邮箱只回给本人', () => {
  it('他人视角不读 email 列, 返回空串', async () => {
    const profile = await getUserProfile({ id: OWNER }, viewer(9))

    expect(userFindUniqueMock.mock.calls[0][0].omit).toEqual({ email: true })
    expect(profile).toMatchObject({ email: '' })
  })

  it('本人视角显式取回 email', async () => {
    const profile = await getUserProfile({ id: OWNER }, viewer(OWNER))

    expect(userFindUniqueMock.mock.calls[0][0].omit).toEqual({ email: false })
    expect(profile).toMatchObject({ email: 'kun@example.com' })
  })
})
