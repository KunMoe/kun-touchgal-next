import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  verifyHeaderCookieMock,
  createTagMock,
  updateTagMock,
  deleteTagMock,
  getTagByIdMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  createTagMock: vi.fn(),
  updateTagMock: vi.fn(),
  deleteTagMock: vi.fn(),
  getTagByIdMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

// service 各自有测试, 这里只钉路由闸门: 断言是否走到 service, 不断言 uid 的传法
vi.mock('~/app/api/tag/create', () => ({ createTag: createTagMock }))
vi.mock('~/app/api/tag/update', () => ({ updateTag: updateTagMock }))
vi.mock('~/app/api/tag/delete', () => ({ deleteTag: deleteTagMock }))
vi.mock('~/app/api/tag/get', () => ({ getTagById: getTagByIdMock }))

import { DELETE, POST, PUT } from '~/app/api/tag/route'

const ADMIN_ONLY = '本页面仅管理员可访问'
const TAG_ID = 5

const asPayload = (role: number) => ({ uid: 7, name: 'kun', role })

const createBody = (overrides: Record<string, unknown> = {}) => ({
  name: '纯爱',
  introduction: '',
  alias: [],
  ...overrides
})

const updateBody = (overrides: Record<string, unknown> = {}) => ({
  ...createBody(),
  tagId: TAG_ID,
  ...overrides
})

const jsonRequest = (method: 'POST' | 'PUT', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/tag', {
    method,
    body: JSON.stringify(body)
  })

const deleteRequest = (query: string) =>
  new NextRequest(`http://localhost/api/tag?${query}`, { method: 'DELETE' })

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue(asPayload(3))
  createTagMock.mockResolvedValue({ id: TAG_ID, name: '纯爱' })
  updateTagMock.mockResolvedValue({ id: TAG_ID, name: '纯爱' })
  deleteTagMock.mockResolvedValue({})
})

describe('POST /api/tag 闸门 (tag.manage)', () => {
  it('请求体非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(jsonRequest('POST', createBody({ name: '' })))

    expect(await res.json()).toBe('标签名不可为空')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(createTagMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不调 service', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toBe('用户未登录')
    expect(createTagMock).not.toHaveBeenCalled()
  })

  it.each([1, 2])('role %i 被拒, 不调 service', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toBe(ADMIN_ONLY)
    expect(createTagMock).not.toHaveBeenCalled()
  })

  it.each([3, 4])('role %i 通过闸门并交给 service', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toEqual({ id: TAG_ID, name: '纯爱' })
    expect(createTagMock).toHaveBeenCalledTimes(1)
    expect(createTagMock.mock.calls[0][0]).toEqual(createBody())
  })
})

describe('PUT /api/tag 闸门 (tag.manage)', () => {
  it('请求体非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await PUT(jsonRequest('PUT', updateBody({ name: '' })))

    expect(await res.json()).toBe('标签名不可为空')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(updateTagMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不调 service', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await PUT(jsonRequest('PUT', updateBody()))

    expect(await res.json()).toBe('用户未登录')
    expect(updateTagMock).not.toHaveBeenCalled()
  })

  it.each([1, 2])('role %i 被拒, 不调 service', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await PUT(jsonRequest('PUT', updateBody()))

    expect(await res.json()).toBe(ADMIN_ONLY)
    expect(updateTagMock).not.toHaveBeenCalled()
  })

  it.each([3, 4])('role %i 通过闸门并交给 service', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await PUT(jsonRequest('PUT', updateBody()))

    expect(await res.json()).toEqual({ id: TAG_ID, name: '纯爱' })
    expect(updateTagMock).toHaveBeenCalledTimes(1)
    expect(updateTagMock.mock.calls[0][0]).toEqual(updateBody())
  })
})

describe('DELETE /api/tag 闸门 (tag.manage)', () => {
  it('tagId 非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await DELETE(deleteRequest('tagId=0'))

    expect(await res.json()).toBe('标签 ID 无效')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(deleteTagMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不调 service', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await DELETE(deleteRequest(`tagId=${TAG_ID}`))

    expect(await res.json()).toBe('用户未登录')
    expect(deleteTagMock).not.toHaveBeenCalled()
  })

  it.each([1, 2])('role %i 被拒, 不调 service', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await DELETE(deleteRequest(`tagId=${TAG_ID}`))

    expect(await res.json()).toBe(ADMIN_ONLY)
    expect(deleteTagMock).not.toHaveBeenCalled()
  })

  it.each([3, 4])('role %i 通过闸门并按 tagId 删除', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await DELETE(deleteRequest(`tagId=${TAG_ID}`))

    expect(await res.json()).toEqual({})
    expect(deleteTagMock).toHaveBeenCalledWith(TAG_ID)
  })
})
