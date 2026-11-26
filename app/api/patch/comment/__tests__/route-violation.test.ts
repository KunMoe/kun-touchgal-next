import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'

const { verifyHeaderCookieMock, parsePostMock, createPatchCommentMock } =
  vi.hoisted(() => ({
    verifyHeaderCookieMock: vi.fn(),
    parsePostMock: vi.fn(),
    createPatchCommentMock: vi.fn()
  }))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))
// 路由声明了频率预算: 不 mock 的话会去连真实 Redis (连上就写计数, 连不上就放行), 都不该在单测里发生
vi.mock('~/server/abuse/budget', () => ({
  kunAbuseGate: vi.fn(async () => null)
}))
vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))
vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePostBody: parsePostMock
}))
vi.mock('~/app/api/patch/comment/create', () => ({
  createPatchComment: createPatchCommentMock
}))
vi.mock('~/app/api/patch/comment/get', () => ({ getPatchComment: vi.fn() }))
vi.mock('~/app/api/patch/comment/update', () => ({ updateComment: vi.fn() }))
vi.mock('~/app/api/patch/comment/delete', () => ({ deleteComment: vi.fn() }))
vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { POST } from '~/app/api/patch/comment/route'
import { kunLog } from '~/lib/log.server'

// P02-07 / X02-05: 补丁在预检之后被删, 顶层评论的 patch_id 外键在 create 里撞 P2003。
// create.ts 没有翻译它, 兜底之前冒泡成空体 500 (发布按钮一直转圈), 兜底之后回 200 + 通用文案
const request = new Request('http://localhost/api/patch/comment', {
  method: 'POST'
}) as unknown as Parameters<typeof POST>[0]

beforeEach(() => {
  vi.resetAllMocks()
  parsePostMock.mockResolvedValue({ patchId: 9, content: '好玩' })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 7, role: 1, name: 'kun' })
})

describe('POST /api/patch/comment 违例兜底', () => {
  it('create 撞外键 P2003 时回 200 + 通用文案, 不再冒成 500', async () => {
    createPatchCommentMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2003',
        clientVersion: 'test'
      })
    )

    const response = await POST(request)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toBe(
      '相关内容不存在或已被删除, 请刷新页面后重试'
    )
    expect(kunLog).toHaveBeenCalledWith(
      'route.violation',
      expect.objectContaining({ path: '/api/patch/comment', code: 'P2003' })
    )
  })
})
