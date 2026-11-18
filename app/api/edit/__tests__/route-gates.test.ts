import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { verifyHeaderCookieMock, createGalgameMock, updateGalgameMock } =
  vi.hoisted(() => ({
    verifyHeaderCookieMock: vi.fn(),
    createGalgameMock: vi.fn(),
    updateGalgameMock: vi.fn()
  }))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

// service 各自有测试, 这里只钉路由闸门: 断言是否走到 service, 不断言 uid 的传法
vi.mock('~/app/api/edit/create', () => ({ createGalgame: createGalgameMock }))
vi.mock('~/app/api/edit/update', () => ({ updateGalgame: updateGalgameMock }))

import { POST, PUT } from '~/app/api/edit/route'

const SUPER_ADMIN_ONLY = '本页面仅超级管理员可访问'
const ADMIN_ONLY = '本页面仅管理员可访问'

const asPayload = (role: number) => ({ uid: 7, name: 'kun', role })

const createFormData = (overrides: Record<string, string> = {}) => {
  const formData = new FormData()
  formData.append(
    'banner',
    new File([new Uint8Array([1, 2, 3])], 'banner.avif')
  )
  formData.append('name', '测试 Galgame')
  formData.append('vndbId', '')
  formData.append('vndbRelationId', '')
  formData.append('bangumiId', '')
  formData.append('steamId', '')
  formData.append('dlsiteCode', '')
  formData.append('introduction', '这是一段足够长的游戏介绍文本')
  formData.append('alias', JSON.stringify([]))
  formData.append('tag', JSON.stringify(['标签一']))
  formData.append('released', '2026-01-01')
  formData.append('contentLimit', 'sfw')
  for (const [key, value] of Object.entries(overrides)) {
    formData.set(key, value)
  }
  return formData
}

const updateBody = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  name: '测试 Galgame',
  vndbId: '',
  vndbRelationId: '',
  bangumiId: '',
  steamId: '',
  dlsiteCode: '',
  introduction: '这是一段足够长的游戏介绍文本',
  tag: ['标签一'],
  alias: [],
  contentLimit: 'sfw',
  ...overrides
})

const postRequest = (formData: FormData) =>
  new NextRequest('http://localhost/api/edit', {
    method: 'POST',
    body: formData
  })

const putRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/edit', {
    method: 'PUT',
    body: JSON.stringify(body)
  })

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue(asPayload(4))
  createGalgameMock.mockResolvedValue({ uniqueId: 'abcd1234' })
  updateGalgameMock.mockResolvedValue({})
})

describe('POST /api/edit 闸门 (galgame.create)', () => {
  it('表单非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(postRequest(createFormData({ name: '' })))

    expect(await res.json()).toBe('游戏名称是必填项')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(createGalgameMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不调 service', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(postRequest(createFormData()))

    expect(await res.json()).toBe('用户未登录')
    expect(createGalgameMock).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3])(
    'role %i 返回 本页面仅超级管理员可访问, 不调 service',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      const res = await POST(postRequest(createFormData()))

      expect(await res.json()).toBe(SUPER_ADMIN_ONLY)
      expect(createGalgameMock).not.toHaveBeenCalled()
    }
  )

  it('role 4 通过闸门并交给 service', async () => {
    const res = await POST(postRequest(createFormData()))

    expect(await res.json()).toEqual({ uniqueId: 'abcd1234' })
    expect(createGalgameMock).toHaveBeenCalledTimes(1)
    expect(createGalgameMock.mock.calls[0][0]).toMatchObject({
      name: '测试 Galgame',
      alias: [],
      tag: ['标签一']
    })
  })

  it('角色闸门先于别名/标签校验: role 3 提交非法别名仍得到权限消息', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(3))
    const res = await POST(postRequest(createFormData({ alias: 'not-json' })))

    expect(await res.json()).toBe(SUPER_ADMIN_ONLY)
  })

  it('role 4 提交非法别名时返回别名格式消息', async () => {
    const res = await POST(postRequest(createFormData({ alias: 'not-json' })))

    expect(await res.json()).toBe('别名格式不正确')
    expect(createGalgameMock).not.toHaveBeenCalled()
  })
})

describe('PUT /api/edit 闸门 (galgame.rewrite)', () => {
  it('请求体非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await PUT(putRequest(updateBody({ name: '' })))

    expect(await res.json()).toBe('游戏名称是必填项')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(updateGalgameMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不调 service', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await PUT(putRequest(updateBody()))

    expect(await res.json()).toBe('用户未登录')
    expect(updateGalgameMock).not.toHaveBeenCalled()
  })

  it.each([1, 2])(
    'role %i 返回 本页面仅管理员可访问, 不调 service',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      const res = await PUT(putRequest(updateBody()))

      expect(await res.json()).toBe(ADMIN_ONLY)
      expect(updateGalgameMock).not.toHaveBeenCalled()
    }
  )

  it.each([3, 4])('role %i 通过闸门并交给 service', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await PUT(putRequest(updateBody()))

    expect(await res.json()).toEqual({})
    expect(updateGalgameMock).toHaveBeenCalledTimes(1)
    expect(updateGalgameMock.mock.calls[0][0]).toMatchObject({
      id: 42,
      name: '测试 Galgame',
      tag: ['标签一']
    })
  })

  it('service 返回错误串时原样返回', async () => {
    updateGalgameMock.mockResolvedValue('未找到该 Galgame')
    const res = await PUT(putRequest(updateBody()))

    expect(await res.json()).toBe('未找到该 Galgame')
  })
})
