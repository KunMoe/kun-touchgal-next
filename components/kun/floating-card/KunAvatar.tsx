'use client'

import { Avatar } from '@heroui/avatar'
import { useRouter } from '@bprogress/next/app'
import { KunUserCardTooltip, preloadKunUserCard } from './KunUserCardTooltip'
import type { AvatarProps } from '@heroui/avatar'

interface KunAvatarProps extends AvatarProps {
  name: string
  src: string
}

interface Props {
  uid: number
  avatarProps: KunAvatarProps
}

export const KunAvatar = ({ uid, avatarProps }: Props) => {
  const router = useRouter()

  const { alt, name, ...rest } = avatarProps
  const username = name?.charAt(0).toUpperCase() ?? '杂鱼'
  const altString = alt ? alt : username

  return (
    <KunUserCardTooltip uid={uid}>
      <Avatar
        name={username}
        alt={altString}
        className="transition-transform duration-200 cursor-pointer shrink-0 hover:scale-110"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()

          router.push(`/user/${uid}/comment`)
        }}
        onMouseEnter={preloadKunUserCard}
        onFocus={preloadKunUserCard}
        {...rest}
      />
    </KunUserCardTooltip>
  )
}
