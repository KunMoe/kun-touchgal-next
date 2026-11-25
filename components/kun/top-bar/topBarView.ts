import type { KunSessionStatus } from '~/store/userStore'

export type KunTopBarView = 'skeleton' | 'guest' | 'user'

// 顶栏右侧显示什么只看这个文档判定过的身份: 判定之前 (首帧、Suspense fallback、等会话回查)
// 一律骨架, 判定之后随站内登入 / 登出立即切换。不拿 initialSession 与 store 比对 ——
// 根布局在软导航里不重渲染, initialSession 一直是整页加载那一刻的值
export const deriveTopBarView = ({
  isMounted,
  isSessionPending,
  status
}: {
  isMounted: boolean
  isSessionPending: boolean
  status: KunSessionStatus
}): KunTopBarView => {
  if (!isMounted || isSessionPending || status === 'pending') {
    return 'skeleton'
  }
  return status === 'authenticated' ? 'user' : 'guest'
}
