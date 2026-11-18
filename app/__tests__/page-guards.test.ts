import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement } from 'react'

const { redirectMock, verifyHeaderCookieMock, kunGetActionsMock } = vi.hoisted(
  () => ({
    redirectMock: vi.fn(),
    verifyHeaderCookieMock: vi.fn(),
    kunGetActionsMock: vi.fn()
  })
)

vi.mock('next/navigation', () => ({ redirect: redirectMock }))

vi.mock('~/utils/actions/verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/app/apply/actions', () => ({
  kunGetActions: kunGetActionsMock
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
import RewritePage from '~/app/edit/rewrite/page'
import EditPage from '~/app/edit/page'
import ApplyPage from '~/app/apply/page'
import { CreatePatch } from '~/components/edit/create/CreatePatch'
import { RewritePatch } from '~/components/edit/rewrite/RewritePatch'
import { ApplyContainer } from '~/components/apply/Container'

interface RenderedElement {
  type: unknown
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

describe('app/edit/rewrite/page 守卫 (galgame.rewrite)', () => {
  it('未登录重定向到首页', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    await expectRedirectTo(RewritePage, '/')
  })

  it.each([1, 2])('role %i 重定向到首页', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))

    await expectRedirectTo(RewritePage, '/')
  })

  it.each([3, 4])('role %i 渲染重新编辑表单', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))

    const element = await render(RewritePage)

    expect(redirectMock).not.toHaveBeenCalled()
    expect((element.props.children as RenderedElement).type).toBe(RewritePatch)
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
