'use client'

import { Button } from '@heroui/button'
import { Tooltip } from '@heroui/tooltip'
import { Bell, BellRing } from 'lucide-react'
import { useRouter } from '@bprogress/next/app'

interface AnimatedNotificationBellProps {
  hasUnreadMessages: boolean
  setReadMessage: () => void
}

export const UserMessageBell = ({
  hasUnreadMessages,
  setReadMessage
}: AnimatedNotificationBellProps) => {
  const router = useRouter()

  const handleClickButton = () => {
    router.push('/message/notice')
    if (hasUnreadMessages) {
      setReadMessage()
    }
  }

  return (
    <Tooltip
      disableAnimation
      showArrow
      closeDelay={0}
      content={hasUnreadMessages ? '您有新消息!' : '我的消息'}
    >
      <Button
        isIconOnly
        variant="light"
        onPress={handleClickButton}
        className="relative"
        aria-label="我的消息"
      >
        <div className={hasUnreadMessages ? 'animate-bell-shake' : ''}>
          {hasUnreadMessages ? (
            <BellRing className="size-6 text-primary" />
          ) : (
            <Bell className="size-6 text-default-500" />
          )}
        </div>

        {hasUnreadMessages && (
          <div className="absolute rounded-full bottom-1 right-1 size-2 animate-dot-in bg-danger" />
        )}
      </Button>
    </Tooltip>
  )
}
