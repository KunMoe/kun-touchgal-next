'use client'

import { useShallow } from 'zustand/react/shallow'
import toast from 'react-hot-toast'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { NavbarContent, NavbarItem } from '@heroui/navbar'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Button } from '@heroui/button'
import { Skeleton } from '@heroui/skeleton'
import { useUserStore } from '~/store/userStore'
import { useMessageStore } from '~/store/messageStore'
import { useSettingStore } from '~/store/settingStore'
import { useRouter } from '@bprogress/next/app'
import { ThemeSwitcher } from './ThemeSwitcher'
import { useMounted } from '~/hooks/useMounted'
import { KunSearch } from './Search'
import { UserMessageBell } from './UserMessageBell'
import { Tooltip } from '@heroui/tooltip'
import { RandomGalgameButton } from '~/components/home/carousel/RandomGalgameButton'
import { buildKunLoginHref } from '~/utils/loginRedirect'
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
  const router = useRouter()
  const { user, setUser, logout } = useUserStore(
    useShallow((state) => ({
      user: state.user,
      setUser: state.setUser,
      logout: state.logout
    }))
  )
  const {
    hasUnreadNotification,
    hasUnreadConversation,
    setHasUnreadNotification,
    setUnreadMessageStatus,
    resetUnreadMessageStatus
  } = useMessageStore(
    useShallow((state) => ({
      hasUnreadNotification: state.hasUnreadNotification,
      hasUnreadConversation: state.hasUnreadConversation,
      setHasUnreadNotification: state.setHasUnreadNotification,
      setUnreadMessageStatus: state.setUnreadMessageStatus,
      resetUnreadMessageStatus: state.resetUnreadMessageStatus
    }))
  )
  const resetSettings = useSettingStore((state) => state.resetData)
  const isMounted = useMounted()
  const dropdownModule = useSyncExternalStore(
    subscribeUserDropdown,
    getUserDropdownModule,
    getServerUserDropdownModule
  )
  const missingSessionCheckedRef = useRef(false)
  const [isMissingSessionChecked, setIsMissingSessionChecked] = useState(
    !!initialSession || isSessionPending
  )

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

      setUser(initialSession.user)
      setUnreadMessageStatus(initialSession.unread)
      setIsMissingSessionChecked(true)
    }

    void hydrateSession()

    return () => {
      cancelled = true
    }
  }, [initialSession, isMounted, setUnreadMessageStatus, setUser])

  useEffect(() => {
    if (
      !isMounted ||
      isSessionPending ||
      initialSession ||
      missingSessionCheckedRef.current
    ) {
      return
    }

    missingSessionCheckedRef.current = true
    let cancelled = false
    const handleMissingSession = async () => {
      await useSettingStore.persist.rehydrate()
      const hasStoredUser = hasPersistedUserStore()
      if (hasStoredUser) {
        await useUserStore.persist.rehydrate()
      }
      if (cancelled) {
        return
      }

      const currentUser = hasStoredUser
        ? useUserStore.getState().user
        : { uid: 0 }
      if (currentUser.uid) {
        const [sessionCheck] = await Promise.all([
          fetchCurrentSession(),
          ensureUserDropdownModule()
        ])
        if (cancelled) {
          return
        }
        if (sessionCheck.status === 'valid') {
          setUser(sessionCheck.session.user)
          setUnreadMessageStatus(sessionCheck.session.unread)
          setIsMissingSessionChecked(true)
          return
        }
        if (sessionCheck.status === 'unreachable') {
          setIsMissingSessionChecked(true)
          return
        }

        toast.error('用户登录失效')
        logout()
        resetUnreadMessageStatus()
        resetSettings()
        router.push(
          buildKunLoginHref(window.location.pathname, window.location.search)
        )
        return
      }
      setIsMissingSessionChecked(true)
    }

    void handleMissingSession()

    return () => {
      cancelled = true
    }
  }, [
    setUnreadMessageStatus,
    setUser,
    initialSession,
    isSessionPending,
    isMounted,
    logout,
    resetSettings,
    resetUnreadMessageStatus,
    router
  ])

  const isSessionReady = isSessionPending
    ? false
    : initialSession
      ? user.uid === initialSession.user.uid
      : isMissingSessionChecked

  const hasUnread = hasUnreadNotification || hasUnreadConversation
  const isUserReady = isMounted && isSessionReady && !!user.name

  // 站内登录 (登录页 setUser) 等不经过上面两条会话路径的翻转, 以及加载失败后的重试
  useEffect(() => {
    if (!isUserReady || dropdownModule) {
      return
    }
    void ensureUserDropdownModule()
  }, [dropdownModule, isUserReady])

  return (
    <NavbarContent as="div" className="items-center" justify="end">
      {(!isMounted || !isSessionReady) && (
        <>
          <Skeleton className="hidden rounded-lg lg:flex">
            <div className="w-32 h-10 rounded-lg bg-default-300" />
          </Skeleton>
          <Skeleton className="rounded-lg lg:hidden">
            <div className="w-20 h-10 rounded-lg bg-default-300" />
          </Skeleton>
        </>
      )}

      {isMounted && isSessionReady && !user.name && <KunTopBarGuestEntry />}

      <KunSearch />

      <Tooltip disableAnimation showArrow closeDelay={0} content="随机一部游戏">
        <RandomGalgameButton isIconOnly variant="light" />
      </Tooltip>

      <ThemeSwitcher />

      {isUserReady && (
        <>
          <UserMessageBell
            hasUnreadMessages={hasUnread}
            setReadMessage={() => setHasUnreadNotification(false)}
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
