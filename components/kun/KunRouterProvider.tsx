'use client'

import { createContext, useContext, useMemo } from 'react'
import { useRouter as useNextRouter } from 'next/navigation'
import { useRouter as useProgressRouter } from '@bprogress/next/app'
import type { ReactNode } from 'react'

// Next 16.3 的 useRouter() 为读 bfcacheId 订阅了 LayoutRouterContext, 任何 URL 变化
// (包括 history.replaceState 只改 ?tab=) 都会让每个调用方在点击事件里同步重渲染.
// 列表项 (KunUser / KunAvatar / 资源卡片) 改从这里取根部调用一次得到的实例:
// 两者返回值身份稳定, 消费方不再随 URL 重渲染
interface KunRouters {
  progress: ReturnType<typeof useProgressRouter>
  next: ReturnType<typeof useNextRouter>
}

const KunRouterContext = createContext<KunRouters | null>(null)

export const KunRouterProvider = ({ children }: { children: ReactNode }) => {
  const progress = useProgressRouter()
  const next = useNextRouter()
  const routers = useMemo(() => ({ progress, next }), [progress, next])

  return <KunRouterContext value={routers}>{children}</KunRouterContext>
}

const useKunRouters = () => {
  const routers = useContext(KunRouterContext)
  if (!routers) {
    throw new Error('useKunRouter must be used within KunRouterProvider')
  }
  return routers
}

// 带顶部进度条, 等同 @bprogress/next/app 的 useRouter
export const useKunRouter = () => useKunRouters().progress

// 不带进度条, 等同 next/navigation 的 useRouter
export const useKunNextRouter = () => useKunRouters().next
