import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  parsePostBodyMock,
  verifyHeaderCookieMock,
  commentFindUniqueMock,
  reportFindFirstMock,
  reportCreateMock
} = vi.hoisted(() => ({
  parsePostBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  commentFindUniqueMock: vi.fn(),
  reportFindFirstMock: vi.fn(),
  reportCreateMock: vi.fn()
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePostBody: parsePostBodyMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma', () => ({
  prisma: {
    patch_comment: { findUnique: commentFindUniqueMock },
    patch_report: { findFirst: reportFindFirstMock, create: reportCreateMock }
  }
}))

import { POST } from '~/app/api/patch/comment/report/route'

const mockRequest = {} as never

beforeEach(() => {
  vi.resetAllMocks()
  parsePostBodyMock.mockResolvedValue({
    commentId: 12,
    patchId: 10,
    content: '广告'
  })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 8 })
  commentFindUniqueMock.mockResolvedValue({
    id: 12,
    user_id: 7,
    patch_id: 10,
    status: 0
  })
  reportFindFirstMock.mockResolvedValue(null)
  reportCreateMock.mockResolvedValue({ id: 1 })
})

describe('评论举报', () => {
  it('预检通过后写入一条举报', async () => {
    const res = await POST(mockRequest)

    await expect(res.json()).resolves.toEqual({})
    expect(reportCreateMock).toHaveBeenCalledWith({
      data: {
        target_type: 'comment',
        reason: '广告',
        sender_id: 8,
        reported_user_id: 7,
        patch_id: 10,
        comment_id: 12
      }
    })
  })

  // 删除命令锁着根评论与整棵回复子树: 预检之后评论被删时, 这次插入要等删除提交,
  // 随后撞外键
  it('评论在预检之后被删 (P2003): 与预检一样返回「评论不存在」', async () => {
    reportCreateMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('FK violation', {
        code: 'P2003',
        clientVersion: 'test'
      })
    )

    const res = await POST(mockRequest)

    await expect(res.json()).resolves.toBe('评论不存在')
  })

  it('其他写入失败原样抛出', async () => {
    reportCreateMock.mockRejectedValue(new Error('connection reset'))

    await expect(POST(mockRequest)).rejects.toThrow('connection reset')
  })
})
