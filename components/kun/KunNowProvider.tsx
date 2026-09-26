'use client'

import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

// 服务端渲染时刻, 经 RSC payload 下发, 保证 SSR 与水合首帧用同一个 now 计算相对时间
const KunServerNowContext = createContext<number | null>(null)

export const KunNowProvider = ({
  now,
  children
}: {
  now: number
  children: ReactNode
}) => (
  <KunServerNowContext.Provider value={now}>
    {children}
  </KunServerNowContext.Provider>
)

const noopSubscribe = () => () => {}

// SSR 与水合期间返回服务端 now; 水合完成后(以及之后客户端新挂载的组件)返回浏览器当前时间
export const useKunNow = () => {
  const serverNow = useContext(KunServerNowContext)
  const isHydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  )
  // 水合后按渲染时刻读浏览器时钟是本 hook 的用途, 相对时间本就随重渲染刷新
  // eslint-disable-next-line react-hooks/purity
  return isHydrated || serverNow === null ? Date.now() : serverNow
}
