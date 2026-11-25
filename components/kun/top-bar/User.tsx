'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { NavbarContent, NavbarItem } from '@heroui/navbar'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Button } from '@heroui/button'
import { Skeleton } from '@heroui/skeleton'
import {
  getKunUserSnapshot,
  rehydrateKunUserStore,
  useUserStore
} from '~/store/userStore'
import { useMessageStore } from '~/store/messageStore'
import { useSettingStore } from '~/store/settingStore'
import {
  keepKunStoredSession,
  markKunSessionGuest,
  markNotificationsSeen,
  reconcileKunSession
} from '~/store/session'
import { useKunSignOut } from '~/hooks/useKunSession'
import { ThemeSwitcher } from './ThemeSwitcher'
import { useMounted } from '~/hooks/useMounted'
import { KunSearch } from './Search'
import { UserMessageBell } from './UserMessageBell'
import { Tooltip } from '@heroui/tooltip'
import { RandomGalgameButton } from '~/components/home/carousel/RandomGalgameButton'
import { buildKunLoginHref } from '~/utils/loginRedirect'
import { deriveTopBarView } from './topBarView'
import type { UserSession } from '~/types/api/session'

interface Props {
  initialSession: UserSession | null
  isSessionPending?: boolean
}

type SessionCheckResult =
  | { status: 'valid'; session: UserSession }
  | { status: 'invalid' }
  | { status: 'unreachable' }

const hasPersistedUserStore = () => {
  try {
    return Boolean(window.localStorage.getItem('kun-patch-user-store'))
  } catch {
    return true
  }
}

// UserDropdown 连带 Dropdown / Menu / Popover / Modal / Avatar 只对登录用户渲染, 静态导入
// 会让游客在每一页都下载它们. 改为确认会话时并行按需加载, 加载完成后再翻转会话状态,
// 头像与铃铛仍在同一帧出现. 不用 next/dynamic: 会话翻转由 zustand 同步渲染驱动, 走
// Suspense 揭示会被 React 19 节流到 fallback 后 300ms, 预热也绕不开
const loadUserDropdown = () => import('./UserDropdown')
type UserDropdownModule = Awaited<ReturnType<typeof loadUserDropdown>>
let userDropdownModule: UserDropdownModule | null = null
let userDropdownLoading: Promise<void> | null = null
const userDropdownListeners = new Set<() => void>()
const subscribeUserDropdown = (listener: () => void) => {
  userDropdownListeners.add(listener)
  return () => {
    userDropdownListeners.delete(listener)
  }
}
const getUserDropdownModule = () => userDropdownModule
const getServerUserDropdownModule = () => null
const ensureUserDropdownModule = () => {
  if (userDropdownModule) {
    return Promise.resolve()
  }
  userDropdownLoading ??= loadUserDropdown()
    .then(
      (module) => {
        userDropdownModule = module
        userDropdownListeners.forEach((listener) => listener())
      },
      // 块加载失败: 头像位保留骨架, 会话就绪后的 effect 会再试一次
      () => {}
    )
    .finally(() => {
      userDropdownLoading = null
    })
  return userDropdownLoading
}
const fetchCurrentSession = async (): Promise<SessionCheckResult> => {
  try {
    const response = await fetch('/api/user/session', {
      credentials: 'include',
      cache: 'no-store'
    })

    if (response.status === 401) {
      return { status: 'invalid' }
    }
    if (!response.ok) {
      return { status: 'unreachable' }
    }

    const session = (await response.json()) as UserSession | string
    return typeof session === 'string'
      ? { status: 'invalid' }
      : { status: 'valid', session }
  } catch {
    return { status: 'unreachable' }
  }
}

// 登录链接须携带完整 pathname+search 才能在登录后回跳; useSearchParams 在静态
// 预渲染会触发 CSR bailout (顶栏位于根 layout 的 Suspense fallback 内, 不受边界
// 保护), 故隔离在仅 isMounted 后渲染的子组件里, 服务端不会执行到
const KunTopBarGuestEntry = () => {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const loginHref = buildKunLoginHref(pathname, searchParams.toString())

  return (
    <NavbarContent justify="end">
      <NavbarItem className="hidden lg:flex">
        <Link href={loginHref}>登录</Link>
      </NavbarItem>
      <NavbarItem>
        <Button
          as={Link}
          color="primary"
          href="/register"
          variant="flat"
          className="hidden lg:flex"
        >
          注册
        </Button>
      </NavbarItem>
      <NavbarItem className="flex lg:hidden">
        <Button as={Link} color="primary" href={loginHref} variant="flat">
          登录
        </Button>
      </NavbarItem>
    </NavbarContent>
  )
}

export const KunTopBarUser = ({ initialSession, isSessionPending }: Props) => {
  const status = useUserStore((state) => state.status)
  const hasUnread = useMessageStore(
    (state) => state.hasUnreadNotification || state.hasUnreadConversation
  )
  const signOut = useKunSignOut()
  const isMounted = useMounted()
  const dropdownModule = useSyncExternalStore(
    subscribeUserDropdown,
    getUserDropdownModule,
    getServerUserDropdownModule
  )
  // 骨架只等首次判定访客身份 (store 的 status 离开 pending 之后不再回去): 根布局在软导航里
  // 不重渲染, initialSession 一直是整页加载时的值, 之后的站内登入 / 登出只改 store
  const view = deriveTopBarView({
    isMounted,
    isSessionPending: !!isSessionPending,
    status
  })

  useEffect(() => {
    if (!isMounted || !initialSession) {
      return
    }

    let cancelled = false
    const hydrateSession = async () => {
      await Promise.all([
        useSettingStore.persist.rehydrate(),
        ensureUserDropdownModule()
      ])
      if (cancelled) {
        return
      }

      reconcileKunSession(initialSession)
    }

    void hydrateSession()

    return () => {
      cancelled = true
    }
  }, [initialSession, isMounted])

  // 首屏没有会话: 整页加载时判定一次; 同一文档里 router.refresh 带回的会话从有变成没有时
  // (status 仍是 authenticated) 也会再走一遍, 由回查决定是否登出
  useEffect(() => {
    if (!isMounted || isSessionPending || initialSession) {
      return
    }

    let cancelled = false
    const handleMissingSession = async () => {
      await useSettingStore.persist.rehydrate()
      const hasStoredUser = hasPersistedUserStore()
      if (hasStoredUser) {
        await rehydrateKunUserStore()
      }
      if (cancelled) {
        return
      }

      const currentUser = hasStoredUser ? getKunUserSnapshot() : { uid: 0 }
      if (!currentUser.uid) {
        markKunSessionGuest()
        return
      }

      const [sessionCheck] = await Promise.all([
        fetchCurrentSession(),
        ensureUserDropdownModule()
      ])
      if (cancelled) {
        return
      }
      if (sessionCheck.status === 'valid') {
        reconcileKunSession(sessionCheck.session)
        return
      }
      if (sessionCheck.status === 'unreachable') {
        keepKunStoredSession()
        return
      }

      signOut('expired')
    }

    void handleMissingSession()

    return () => {
      cancelled = true
    }
  }, [initialSession, isSessionPending, isMounted, signOut])

  // 站内登录 (登录页 signInKunSession) 等不经过上面两条会话路径的翻转, 以及加载失败后的重试
  useEffect(() => {
    if (view !== 'user' || dropdownModule) {
      return
    }
    void ensureUserDropdownModule()
  }, [dropdownModule, view])

  return (
    <NavbarContent as="div" className="items-center" justify="end">
      {view === 'skeleton' && (
        <>
          <Skeleton className="hidden rounded-lg lg:flex">
            <div className="w-32 h-10 rounded-lg bg-default-300" />
          </Skeleton>
          <Skeleton className="rounded-lg lg:hidden">
            <div className="w-20 h-10 rounded-lg bg-default-300" />
          </Skeleton>
        </>
      )}

      {view === 'guest' && <KunTopBarGuestEntry />}

      <KunSearch />

      <Tooltip disableAnimation showArrow closeDelay={0} content="随机一部游戏">
        <RandomGalgameButton isIconOnly variant="light" />
      </Tooltip>

      <ThemeSwitcher />

      {view === 'user' && (
        <>
          <UserMessageBell
            hasUnreadMessages={hasUnread}
            setReadMessage={markNotificationsSeen}
          />

          {dropdownModule ? (
            <dropdownModule.UserDropdown />
          ) : (
            <Skeleton className="size-8 shrink-0 rounded-full" />
          )}
        </>
      )}
    </NavbarContent>
  )
}
