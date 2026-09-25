'use client'

import { useShallow } from 'zustand/react/shallow'
import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger
} from '@heroui/dropdown'
import { Avatar } from '@heroui/avatar'
import { Button } from '@heroui/button'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import {
  ArrowLeftRight,
  CalendarCheck,
  CircleHelp,
  LogOut,
  Lollipop,
  Settings,
  Sparkles,
  UserRound
} from 'lucide-react'
import { useUserStore } from '~/store/userStore'
import { useSettingStore } from '~/store/settingStore'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from '@bprogress/next/app'
import { kunFetchPost } from '~/utils/kunFetch'
import toast from 'react-hot-toast'
import { showKunSooner } from '~/components/kun/Sooner'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { buildKunLoginHref } from '~/utils/loginRedirect'
import { NSFWSwitcher } from './NSFWSwitcher'
import { useMessageStore } from '~/store/messageStore'

const NESTED_DROPDOWN_EXIT_MS = 50
const OPEN_OVERLAY_MENU_SELECTOR =
  '[data-slot="base"][data-open="true"][data-placement] [role="menu"], [data-slot="base"][data-open="true"][data-placement] [role="listbox"]'

interface OutsidePointerContext {
  shouldCloseParent: boolean
  pointerType: string
}

export const UserDropdown = () => {
  const router = useRouter()
  const { user, setUser, logout } = useUserStore(
    useShallow((state) => ({
      user: state.user,
      setUser: state.setUser,
      logout: state.logout
    }))
  )
  const resetSettings = useSettingStore((state) => state.resetData)
  const resetUnreadMessageStatus = useMessageStore(
    (state) => state.resetUnreadMessageStatus
  )
  const [loading, setLoading] = useState(false)
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [isNsfwDropdownOpen, setIsNsfwDropdownOpen] = useState(false)
  const triggerRef = useRef<HTMLElement>(null!)
  const menuRef = useRef<HTMLUListElement>(null)
  const deferredParentCloseRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const lastPointerContextRef = useRef<OutsidePointerContext | null>(null)
  const { isOpen, onOpen, onOpenChange } = useDisclosure()

  const clearDeferredParentClose = useCallback(() => {
    if (!deferredParentCloseRef.current) {
      return
    }

    clearTimeout(deferredParentCloseRef.current)
    deferredParentCloseRef.current = null
  }, [])

  const handleDropdownOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        clearDeferredParentClose()
        lastPointerContextRef.current = null
      } else if (deferredParentCloseRef.current) {
        return
      } else {
        setIsNsfwDropdownOpen(false)
      }

      setIsDropdownOpen(open)
    },
    [clearDeferredParentClose]
  )

  const getOutsidePointerContext = useCallback(
    (
      target: EventTarget | null,
      pointerType: string
    ): OutsidePointerContext => {
      if (!(target instanceof Node)) {
        return {
          shouldCloseParent: false,
          pointerType
        }
      }

      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return {
          shouldCloseParent: false,
          pointerType
        }
      }

      if (
        target instanceof Element &&
        target.closest(OPEN_OVERLAY_MENU_SELECTOR)
      ) {
        return {
          shouldCloseParent: false,
          pointerType
        }
      }

      return {
        shouldCloseParent: true,
        pointerType
      }
    },
    []
  )

  const closeDropdownAfterNestedClose = useCallback(
    (shouldDelay: boolean) => {
      if (shouldDelay) {
        if (deferredParentCloseRef.current) {
          return
        }

        deferredParentCloseRef.current = setTimeout(() => {
          setIsDropdownOpen(false)
          deferredParentCloseRef.current = null
        }, NESTED_DROPDOWN_EXIT_MS)
        return
      }

      clearDeferredParentClose()
      setIsDropdownOpen(false)
    },
    [clearDeferredParentClose]
  )

  const handleNsfwDropdownOpenChange = useCallback(
    (open: boolean) => {
      setIsNsfwDropdownOpen(open)

      if (open) {
        clearDeferredParentClose()
        lastPointerContextRef.current = null
        return
      }

      const pointerContext = lastPointerContextRef.current
      lastPointerContextRef.current = null

      if (!pointerContext?.shouldCloseParent) {
        return
      }

      closeDropdownAfterNestedClose(pointerContext.pointerType === 'touch')
    },
    [clearDeferredParentClose, closeDropdownAfterNestedClose]
  )

  useEffect(() => {
    if (!isDropdownOpen) {
      return
    }

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const pointerContext = getOutsidePointerContext(
        event.target,
        event.pointerType
      )
      lastPointerContextRef.current = pointerContext

      if (!pointerContext.shouldCloseParent) {
        return
      }

      if (isNsfwDropdownOpen) {
        setIsNsfwDropdownOpen(false)
        closeDropdownAfterNestedClose(pointerContext.pointerType === 'touch')
        return
      }

      handleDropdownOpenChange(false)
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const pointerContext =
        lastPointerContextRef.current ??
        getOutsidePointerContext(event.target, '')

      if (
        !pointerContext.shouldCloseParent ||
        pointerContext.pointerType === 'touch'
      ) {
        return
      }

      lastPointerContextRef.current = null
      clearDeferredParentClose()
      setIsNsfwDropdownOpen(false)
      setIsDropdownOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsidePointerDown, true)
    document.addEventListener('click', closeOnOutsideClick, true)

    return () => {
      document.removeEventListener(
        'pointerdown',
        closeOnOutsidePointerDown,
        true
      )
      document.removeEventListener('click', closeOnOutsideClick, true)
    }
  }, [
    clearDeferredParentClose,
    closeDropdownAfterNestedClose,
    getOutsidePointerContext,
    handleDropdownOpenChange,
    isDropdownOpen,
    isNsfwDropdownOpen
  ])

  useEffect(() => {
    return () => {
      clearDeferredParentClose()
    }
  }, [clearDeferredParentClose])

  const handleLogOut = async () => {
    setLoading(true)
    await kunFetchPost<KunResponse<{}>>('/user/status/logout')
    setLoading(false)
    logout()
    resetUnreadMessageStatus()
    resetSettings()
    router.push(
      buildKunLoginHref(window.location.pathname, window.location.search)
    )
    toast.success('您已经成功登出!')
  }

  const [checking, setChecking] = useState(false)
  const handleCheckIn = async () => {
    if (checking) {
      return
    }

    setChecking(true)
    const res = await kunFetchPost<
      KunResponse<{
        randomMoemoepoints: number
      }>
    >('/user/status/check-in')
    kunErrorHandler(res, (value) => {
      showKunSooner(
        value
          ? `签到成功! 您今天获得了 ${value.randomMoemoepoints} 萌萌点`
          : '您的运气不好...今天没有获得萌萌点...'
      )
      setUser({
        ...user,
        dailyCheckIn: 1,
        moemoepoint: user.moemoepoint + value.randomMoemoepoints
      })
    })
    setChecking(false)
  }

  return (
    <>
      <Dropdown
        isOpen={isDropdownOpen}
        onOpenChange={handleDropdownOpenChange}
        placement="bottom-end"
        isDismissable={false}
        shouldBlockScroll={false}
        triggerRef={triggerRef}
      >
        <DropdownTrigger>
          <Avatar
            isBordered
            as="button"
            className="transition-transform shrink-0"
            color="secondary"
            name={user.name.charAt(0).toUpperCase()}
            size="sm"
            src={user.avatar}
            showFallback
          />
        </DropdownTrigger>
        <DropdownMenu
          ref={menuRef}
          aria-label="Profile Actions"
          disabledKeys={user.dailyCheckIn ? ['check'] : []}
        >
          <DropdownItem
            isReadOnly
            key="username"
            textValue="用户名"
            className="cursor-default data-[hover=true]:bg-background"
          >
            <p className="font-semibold">{user.name}</p>
          </DropdownItem>
          <DropdownItem
            isReadOnly
            textValue="萌萌点"
            key="moemoepoint"
            className="cursor-default data-[hover=true]:bg-background"
            startContent={<Lollipop className="size-4" />}
            endContent={user.moemoepoint}
          >
            萌萌点
          </DropdownItem>
          <DropdownItem
            key="profile"
            href={`/user/${user.uid}/comment`}
            startContent={<UserRound className="size-4" />}
          >
            用户主页
          </DropdownItem>
          <DropdownItem
            key="settings"
            onPress={() => router.push('/settings/user')}
            startContent={<Settings className="size-4" />}
          >
            信息设置
          </DropdownItem>
          <DropdownItem
            key="help_and_feedback"
            onPress={() => router.push(`/doc/notice/feedback`)}
            startContent={<CircleHelp className="size-4" />}
          >
            帮助与反馈
          </DropdownItem>
          <DropdownItem
            isReadOnly
            textValue="NSFW 切换"
            key="nsfw_toggle"
            startContent={<ArrowLeftRight className="size-4" />}
          >
            <NSFWSwitcher
              isOpen={isNsfwDropdownOpen}
              onOpenChange={handleNsfwDropdownOpenChange}
            />
          </DropdownItem>
          <DropdownItem
            key="logout"
            color="danger"
            startContent={<LogOut className="size-4" />}
            onPress={onOpen}
          >
            退出登录
          </DropdownItem>

          <DropdownItem
            key="check"
            textValue="今日签到"
            color="secondary"
            startContent={<CalendarCheck className="size-4" />}
            endContent={
              user.dailyCheckIn ? (
                <span className="text-xs">签到过啦</span>
              ) : (
                <Sparkles className="size-5 text-secondary-500" />
              )
            }
            onPress={handleCheckIn}
          >
            今日签到
          </DropdownItem>
        </DropdownMenu>
      </Dropdown>

      <Modal isOpen={isOpen} onOpenChange={onOpenChange} placement="center">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                您确定要登出网站吗?
              </ModalHeader>
              <ModalBody>
                <p>
                  登出将会清除您的登录状态, 但是不会清除您的编辑草稿 (Galgame,
                  回复等), 您可以稍后继续登录
                </p>
              </ModalBody>
              <ModalFooter>
                <Button color="danger" variant="light" onPress={onClose}>
                  关闭
                </Button>
                <Button
                  color="primary"
                  onPress={() => {
                    handleLogOut()
                    onClose()
                  }}
                  isLoading={loading}
                  disabled={loading}
                >
                  确定
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  )
}
