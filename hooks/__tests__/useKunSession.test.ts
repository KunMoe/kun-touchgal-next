import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { pushMock, toastMock, endMock, order } = vi.hoisted(() => {
  const order: string[] = []
  return {
    order,
    pushMock: vi.fn((href: string) => void order.push(`push ${href}`)),
    endMock: vi.fn(() => void order.push('end')),
    toastMock: {
      success: vi.fn((text: string) => void order.push(`success ${text}`)),
      error: vi.fn((text: string) => void order.push(`error ${text}`))
    }
  }
})

// 只测命令的编排: useCallback 原样返回回调, 路由只记下跳转
vi.mock('react', () => ({ useCallback: <T>(callback: T) => callback }))
vi.mock('@bprogress/next/app', () => ({
  useRouter: () => ({ push: pushMock })
}))
vi.mock('react-hot-toast', () => ({ default: toastMock }))
vi.mock('~/store/session', () => ({ endKunClientSession: endMock }))

import { useKunSignOut } from '~/hooks/useKunSession'

beforeEach(() => {
  order.length = 0
  vi.stubGlobal('window', {
    location: { pathname: '/settings/user', search: '?tab=security' }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useKunSignOut', () => {
  // P31-02: 改密与撤销当前会话的登出曾各写一份清理, 改密那份只清了 user; 两处都跳裸 /login,
  // 违反 776acecd「所有 /login 跳转都带 from」
  it.each([
    ['manual', 'success 您已经成功登出!'],
    ['expired', 'error 用户登录失效'],
    ['revoked', 'success 当前登录会话已撤销, 请重新登录'],
    ['password-changed', 'success 更改密码成功, 请使用新密码重新登录']
  ] as const)(
    '%s: 先清三个 store, 再提示, 再带回跳地址去登录页',
    (reason, toast) => {
      useKunSignOut()(reason)

      expect(order).toEqual([
        'end',
        toast,
        `push /login?from=${encodeURIComponent('/settings/user?tab=security')}`
      ])
    }
  )
})
