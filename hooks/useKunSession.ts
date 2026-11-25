'use client'

import { useCallback } from 'react'
import toast from 'react-hot-toast'
import { useRouter } from '@bprogress/next/app'
import { endKunClientSession } from '~/store/session'
import { buildKunLoginHref } from '~/utils/loginRedirect'

export type KunSignOutReason =
  'manual' | 'expired' | 'revoked' | 'password-changed'

const KUN_SIGN_OUT_TOAST: Record<KunSignOutReason, () => void> = {
  manual: () => toast.success('您已经成功登出!'),
  expired: () => toast.error('用户登录失效'),
  revoked: () => toast.success('当前登录会话已撤销, 请重新登录'),
  'password-changed': () => toast.success('更改密码成功, 请使用新密码重新登录')
}

// 客户端登出的唯一入口: 清掉三个 store, 按原因提示, 跳登录页并带上回跳地址 (776acecd:
// 所有 /login 跳转都带 from)。位置只在调用时读, 不订阅路由 —— 顶栏在根布局的 Suspense
// fallback 里, 顶层用 useSearchParams 会让静态预渲染整页退化成客户端渲染
export const useKunSignOut = () => {
  const router = useRouter()
  return useCallback(
    (reason: KunSignOutReason) => {
      endKunClientSession()
      KUN_SIGN_OUT_TOAST[reason]()
      router.push(
        buildKunLoginHref(window.location.pathname, window.location.search)
      )
    },
    [router]
  )
}
