import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

const { verifyHeaderCookieMock } = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn()
}))

vi.mock('~/utils/actions/verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

import {
  parseSuperAdminAction,
  verifySuperAdmin
} from '~/utils/actions/parseSuperAdminAction'

const schema = z.object({
  page: z.coerce.number().min(1, { message: '页数最小为 1' })
})

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue({ uid: 1, name: 'kun', role: 4 })
})

describe('verifySuperAdmin 超管鉴权收口', () => {
  it('未登录返回登录失效', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    await expect(verifySuperAdmin()).resolves.toBe('用户登录失效')
  })

  it('role 不足返回仅超管可访问', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 1, name: 'kun', role: 3 })

    await expect(verifySuperAdmin()).resolves.toBe('本页面仅超级管理员可访问')
  })

  it('超管通过返回 null', async () => {
    await expect(verifySuperAdmin()).resolves.toBeNull()
  })
})

describe('parseSuperAdminAction 校验与鉴权的错误优先级', () => {
  it('校验失败先于鉴权返回, 不触发鉴权', async () => {
    await expect(parseSuperAdminAction(schema, { page: 0 })).resolves.toBe(
      '页数最小为 1'
    )
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
  })

  it('校验通过但未登录返回鉴权错误', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    await expect(parseSuperAdminAction(schema, { page: 1 })).resolves.toBe(
      '用户登录失效'
    )
  })

  it('校验与鉴权都通过返回解析后的 input', async () => {
    await expect(parseSuperAdminAction(schema, { page: '2' })).resolves.toEqual(
      { page: 2 }
    )
  })
})
