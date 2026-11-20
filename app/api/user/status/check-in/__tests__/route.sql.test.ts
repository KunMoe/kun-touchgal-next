import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectFlatConditionalUpdate } from '~/prisma/__tests__/support/sqlShape'

// 签到依赖的编译器输出 (路由里那段注释的可执行版本): 不连库, 录下真实的 Prisma 为这次
// 调用发出的 SQL。库拿到这条 SQL 之后在并发下的行为由 route.db.test.ts 在真库上守护

const { recorder, verifyHeaderCookieMock } = await vi.hoisted(async () => ({
  recorder: (
    await import('~/prisma/__tests__/support/sqlRecorder')
  ).createSqlRecorder(),
  verifyHeaderCookieMock: vi.fn()
}))

vi.mock('~/prisma/index', () => recorder.module)

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

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
}))

import { POST } from '~/app/api/user/status/check-in/route'

const mockRequest = new Request('http://localhost') as unknown as Parameters<
  typeof POST
>[0]

beforeEach(() => {
  recorder.reset()
  verifyHeaderCookieMock.mockResolvedValue({ uid: 42 })
})

describe('POST /api/user/status/check-in 发出的 SQL', () => {
  it('整个请求只发一条 UPDATE, 签到状态的守卫平铺在它自己的 WHERE 里', async () => {
    const res = await POST(mockRequest)
    await expect(res.json()).resolves.toEqual({
      randomMoemoepoints: expect.any(Number)
    })

    const statements = recorder.take()
    expect(statements).toHaveLength(1)
    expectFlatConditionalUpdate(statements, {
      table: 'user',
      guards: ['id', 'daily_check_in']
    })
  })

  it('库报告这条 UPDATE 影响 0 行时按已签到处理', async () => {
    recorder.reply(/^UPDATE "public"\."user"/, { rowCount: 0 })

    const res = await POST(mockRequest)

    await expect(res.json()).resolves.toBe('您今天已经签到过了')
  })
})
