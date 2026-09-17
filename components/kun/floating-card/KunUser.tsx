'use client'

import { User } from '@heroui/user'
import { useRouter } from '@bprogress/next'
import { KunUserCardTooltip, preloadKunUserCard } from './KunUserCardTooltip'
import type { UserProps } from '@heroui/user'

interface KunUserProps {
  user: KunUser
  userProps: UserProps
}

export const KunUser = ({ user, userProps }: KunUserProps) => {
  const router = useRouter()

  const { avatarProps, ...restUser } = userProps
  const { alt, name, ...restAvatar } = avatarProps!
  const username = name?.charAt(0).toUpperCase() ?? '杂鱼'
  const altString = alt ? alt : username

  return (
    <KunUserCardTooltip uid={user.id}>
      <User
        {...restUser}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          router.push(`/user/${user.id}/comment`)
        }}
        onMouseEnter={preloadKunUserCard}
        onFocus={preloadKunUserCard}
        avatarProps={{
          name: username,
          alt: altString,
          className:
            'transition-transform duration-200 cursor-pointer shrink-0 hover:scale-110',
          ...restAvatar
        }}
        className="cursor-pointer"
      />
    </KunUserCardTooltip>
  )
}
