import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pgErrors } from '~/prisma/__tests__/support/pgErrorFixtures'
import {
  dataStatements,
  expectEscapedIlike,
  expectFlatConditionalUpdate
} from '~/prisma/__tests__/support/sqlShape'

// 改名依赖的编译器输出与错误映射 (路由里那段注释的可执行版本), 不连库

const { recorder, parsePostMock, verifyHeaderCookieMock } = await vi.hoisted(
  async () => ({
    recorder: (
      await import('~/prisma/__tests__/support/sqlRecorder')
    ).createSqlRecorder(),
    parsePostMock: vi.fn(),
    verifyHeaderCookieMock: vi.fn()
  })
)

vi.mock('~/prisma/index', () => recorder.module)

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePostBody: parsePostMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
}))

import { POST } from '~/app/api/user/setting/username/route'

const mockRequest = new Request('http://localhost') as unknown as Parameters<
  typeof POST
>[0]

beforeEach(() => {
  recorder.reset()
  parsePostMock.mockResolvedValue({ username: 'k_n%' })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 42, name: 'OldName' })
})

describe('POST /api/user/setting/username 发出的 SQL', () => {
  it('查重走 ILIKE 且通配符已转义; 扣费与改名是一条平铺 WHERE 的 UPDATE', async () => {
    const res = await POST(mockRequest)
    await expect(res.json()).resolves.toEqual({})

    const statements = recorder.take()
    expect(dataStatements(statements)).toHaveLength(2)
    expectEscapedIlike(statements, { column: 'name', bound: 'k\\_n\\%' })
    const update = expectFlatConditionalUpdate(statements, {
      table: 'user',
      guards: ['id', 'moemoepoint', 'name']
    })
    // 写进库的是原样的新名字, 转义只作用于查重的匹配串
    expect(update.values).toContain('k_n%')
    expect(update.values).not.toContain('k\\_n\\%')
  })

  it('库报告 UPDATE 影响 0 行时报余额不足', async () => {
    recorder.reply(/^UPDATE "public"\."user"/, { rowCount: 0 })

    const res = await POST(mockRequest)

    await expect(res.json()).resolves.toBe(
      '更改用户名最少需要 30 萌萌点, 您的萌萌点不足'
    )
  })

  it('UPDATE 撞上用户名的唯一索引: 驱动的 23505 被认作同名, 不外抛', async () => {
    recorder.reply(/^UPDATE "public"\."user"/, {
      error: pgErrors.uniqueViolation
    })

    const res = await POST(mockRequest)

    await expect(res.json()).resolves.toBe('您的用户名已经有人注册了, 请修改')
  })
})
