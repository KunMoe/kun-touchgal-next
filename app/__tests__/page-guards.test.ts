import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement } from 'react'

const {
  redirectMock,
  notFoundMock,
  verifyHeaderCookieMock,
  kunGetActionsMock,
  kunGetRewriteDataActionsMock
} = vi.hoisted(() => ({
  redirectMock: vi.fn(),
  notFoundMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  kunGetActionsMock: vi.fn(),
  kunGetRewriteDataActionsMock: vi.fn()
}))

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  notFound: notFoundMock
}))

vi.mock('~/utils/actions/verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/app/apply/actions', () => ({
  kunGetActions: kunGetActionsMock
}))

vi.mock('~/app/edit/rewrite/[uniqueId]/actions', () => ({
  kunGetRewriteDataActions: kunGetRewriteDataActionsMock
}))

// 子组件只作为元素类型出现, 不渲染; 替换掉以免拉进整套客户端组件
vi.mock('~/components/admin/Sidebar', () => ({ Sidebar: vi.fn(() => null) }))
vi.mock('~/components/edit/create/CreatePatch', () => ({
  CreatePatch: vi.fn(() => null)
}))
vi.mock('~/components/edit/rewrite/RewritePatch', () => ({
  RewritePatch: vi.fn(() => null)
}))
vi.mock('~/components/apply/Container', () => ({
  ApplyContainer: vi.fn(() => null)
}))

import AdminLayout from '~/app/admin/layout'
import CreatePage from '~/app/edit/create/page'
import LegacyRewritePage from '~/app/edit/rewrite/page'
import RewritePage from '~/app/edit/rewrite/[uniqueId]/page'
import EditPage from '~/app/edit/page'
import ApplyPage from '~/app/apply/page'
import { CreatePatch } from '~/components/edit/create/CreatePatch'
import { RewritePatch } from '~/components/edit/rewrite/RewritePatch'
import { ApplyContainer } from '~/components/apply/Container'

interface RenderedElement {
  type: unknown
  key: string | null
  props: Record<string, unknown> & { children?: unknown }
}

const asPayload = (role: number) => ({ uid: 7, name: 'kun', role })

const render = async (page: () => Promise<unknown>) =>
  (await page()) as RenderedElement

// redirect 只应被调用一次: 真实实现会抛出终止渲染, 第一次调用之后的代码不会执行
const expectRedirectTo = async (page: () => Promise<unknown>, url: string) => {
  await expect(page()).rejects.toThrow('NEXT_REDIRECT')
  expect(redirectMock).toHaveBeenCalledTimes(1)
  expect(redirectMock).toHaveBeenCalledWith(url)
}

beforeEach(() => {
  vi.resetAllMocks()
  // 真实 next/navigation 的 redirect 永不返回, mock 保持同款语义,
  // 否则被拒分支会继续落入渲染造成假阴性
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  })
  notFoundMock.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND')
  })
})

describe('app/admin/layout 守卫 (admin.access)', () => {
  const page = () => AdminLayout({ children: 'child' })

  it('未登录重定向到首页', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    await expectRedirectTo(page, '/')
  })

  it.each([1, 2, 3])('role %i 重定向到首页', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))

    await expectRedirectTo(page, '/')
  })

  it('role 4 正常渲染后台布局', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(4))

    const element = await render(page)

    expect(redirectMock).not.toHaveBeenCalled()
    expect(isValidElement(element)).toBe(true)
  })
})

describe('app/edit/create/page 守卫 (galgame.create)', () => {
  it('未登录重定向到首页', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    await expectRedirectTo(CreatePage, '/')
  })

  it.each([1, 2, 3])('role %i 重定向到首页', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))

    await expectRedirectTo(CreatePage, '/')
  })

  it('role 4 渲染发布表单', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(4))

    const element = await render(CreatePage)

    expect(redirectMock).not.toHaveBeenCalled()
    expect(element.type).toBe(CreatePatch)
  })
})

describe('app/edit/rewrite/[uniqueId]/page 守卫 (galgame.rewrite)', () => {
  const initial = { id: 5, uniqueId: 'abcd1234', name: '测试 Galgame' }
  const page = () =>
    RewritePage({ params: Promise.resolve({ uniqueId: 'abcd1234' }) })

  it('未登录重定向到首页, 不读取游戏数据', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    await expectRedirectTo(page, '/')
    expect(kunGetRewriteDataActionsMock).not.toHaveBeenCalled()
  })

  // 基线里有介绍原文: 守卫必须排在读取之前
  it.each([1, 2])('role %i 重定向到首页, 不读取游戏数据', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))

    await expectRedirectTo(page, '/')
    expect(kunGetRewriteDataActionsMock).not.toHaveBeenCalled()
  })

  it.each([3, 4])('role %i 用页面自己读到的基线渲染表单', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    kunGetRewriteDataActionsMock.mockResolvedValue(initial)

    const element = await render(page)

    expect(redirectMock).not.toHaveBeenCalled()
    expect(kunGetRewriteDataActionsMock).toHaveBeenCalledWith('abcd1234')
    const form = element.props.children as RenderedElement
    expect(form.type).toBe(RewritePatch)
    expect(form.props.initial).toBe(initial)
    // 表单 store 随组件实例存活: 同一路由段里换一个游戏时必须重建, 靠 key 区分
    expect(form.key).toBe('abcd1234')
  })

  it('查无此游戏时回 404', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(3))
    kunGetRewriteDataActionsMock.mockResolvedValue(null)

    await expect(page()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(redirectMock).not.toHaveBeenCalled()
  })
})

// 不带 id 的旧地址: 表单不再靠上一页灌进全局 store 的数据, 这里没有东西可编辑
describe('app/edit/rewrite/page 旧地址', () => {
  it('重定向到首页', () => {
    expect(() => LegacyRewritePage()).toThrow('NEXT_REDIRECT:/')
    expect(redirectMock).toHaveBeenCalledWith('/')
  })
})

describe('app/edit/page 分流', () => {
  it('未登录重定向到登录页并带回跳地址', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    await expectRedirectTo(EditPage, '/login?from=%2Fedit')
  })

  it.each([1, 2, 3])('role %i 重定向到首页', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))

    await expectRedirectTo(EditPage, '/')
  })

  it('role 4 重定向到发布页', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(4))

    await expectRedirectTo(EditPage, '/edit/create')
  })
})

// 角色取自 kunGetActions (库内 user.role), 未登录时它返回 role 0
describe('app/apply/page 守卫 (isCreatorRole)', () => {
  it.each([0, 1])('role %i 渲染申请表单并传入资源数', async (role) => {
    kunGetActionsMock.mockResolvedValue({ count: 2, role })

    const element = await render(ApplyPage)

    expect(redirectMock).not.toHaveBeenCalled()
    expect(element.type).toBe(ApplyContainer)
    expect(element.props.count).toBe(2)
  })

  it.each([2, 3, 4])('role %i 重定向到申请成功页', async (role) => {
    kunGetActionsMock.mockResolvedValue({ count: 5, role })

    await expectRedirectTo(ApplyPage, '/apply/success')
  })
})
