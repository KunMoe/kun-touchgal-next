import type { KunSessionStatus } from '~/store/userStore'

export type KunTopBarView = 'skeleton' | 'guest' | 'user'

// 头像菜单懒块的状态 (components/kun/top-bar/User.tsx 的模块缓存)
export type KunTopBarDropdownState = 'loading' | 'ready' | 'failed'

// 顶栏右侧显示什么只看这个文档判定过的身份: 判定之前 (首帧、Suspense fallback、等会话回查)
// 一律骨架, 判定之后随站内登入 / 登出立即切换。不拿 initialSession 与 store 比对 ——
// 根布局在软导航里不重渲染, initialSession 一直是整页加载那一刻的值。
// 已登录而头像菜单的块还在路上时也是骨架: 会话写入不等块 (按 uid 门控的请求早发),
// 铃铛与头像要等块到齐后同一帧出现 (C20)。块加载失败就不再等, 头像位单独留骨架
export const deriveTopBarView = ({
  isMounted,
  isSessionPending,
  status,
  dropdown
}: {
  isMounted: boolean
  isSessionPending: boolean
  status: KunSessionStatus
  dropdown: KunTopBarDropdownState
}): KunTopBarView => {
  if (!isMounted || isSessionPending || status === 'pending') {
    return 'skeleton'
  }
  if (status === 'guest') {
    return 'guest'
  }
  return dropdown === 'loading' ? 'skeleton' : 'user'
}
