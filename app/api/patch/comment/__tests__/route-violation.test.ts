import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

import { POST } from '~/app/api/patch/comment/route'

// P02-07 / X02-05: 补丁在预检之后被删, 顶层评论的 patch_id 外键在 create 里撞 P2003。
// create.ts 没有翻译它, 兜底之前冒泡成空体 500 (发布按钮一直转圈), 兜底之后回 200 + 通用文案
const request = new Request('http://localhost/api/patch/comment', {
  method: 'POST'
}) as unknown as Parameters<typeof POST>[0]

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetAllMocks()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  parsePostMock.mockResolvedValue({ patchId: 9, content: '好玩' })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 7, role: 1, name: 'kun' })
})
afterEach(() => {
  vi.restoreAllMocks()
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
    expect(warnSpy).toHaveBeenCalledWith(
      '[kunRoute] violation',
      expect.objectContaining({ path: '/api/patch/comment', code: 'P2003' })
    )
  })
})
