import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  verifyHeaderCookieMock,
  userUpdateMock,
  userUpdateManyMock,
  randomNormalIntMock,
  invalidateUserSessionMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  userUpdateMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  randomNormalIntMock: vi.fn(),
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

vi.mock('~/utils/random', () => ({
  randomNormalInt: randomNormalIntMock
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: {
      update: userUpdateMock,
      updateMany: userUpdateManyMock
    }
  }
}))

import { POST } from '~/app/api/user/status/check-in/route'

const mockRequest = new Request('http://localhost') as unknown as Parameters<
  typeof POST
>[0]

beforeEach(() => {
  vi.clearAllMocks()
  verifyHeaderCookieMock.mockResolvedValue({ uid: 42 })
  userUpdateManyMock.mockResolvedValue({ count: 1 })
  randomNormalIntMock.mockReturnValue(5)
  invalidateUserSessionMock.mockResolvedValue(undefined)
})

describe('POST /api/user/status/check-in', () => {
  it('claims the reward through a conditional updateMany guarded by daily_check_in', async () => {
    const res = await POST(mockRequest)
    await expect(res.json()).resolves.toEqual({ randomMoemoepoints: 5 })

    // 守卫必须落在 WHERE 里: 退回无条件 update + 应用层 if 就是 read-then-write 竞态
    expect(userUpdateMock).not.toHaveBeenCalled()
    expect(userUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 42, daily_check_in: 0 },
      data: {
        moemoepoint: { increment: 5 },
        daily_check_in: { set: 1 }
      }
    })
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(42)
  })

  // 真正的原子性由 Postgres 提供: updateMany 发出的是 flat WHERE 的单条 UPDATE,
  // READ COMMITTED 下并发者拿到行锁后重新求值 WHERE 而落空. 这里只能证明路由把
  // count 当作唯一裁决依据 —— 不会在 count=0 时仍然发奖
  it('credits only the caller whose conditional update matched a row', async () => {
    let claimed = false
    userUpdateManyMock.mockImplementation(async () => {
      if (claimed) {
        return { count: 0 }
      }
      claimed = true
      return { count: 1 }
    })

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => POST(mockRequest))
    )
    const bodies = await Promise.all(responses.map((res) => res.json()))

    expect(bodies.filter((body) => typeof body !== 'string')).toEqual([
      { randomMoemoepoints: 5 }
    ])
    expect(bodies.filter((body) => body === '您今天已经签到过了')).toHaveLength(
      7
    )
    expect(invalidateUserSessionMock).toHaveBeenCalledTimes(1)
  })
})
