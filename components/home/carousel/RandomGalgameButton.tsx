'use client'

import { Button } from '@heroui/react'
import { Dices } from 'lucide-react'
import { useRouter } from '@bprogress/next/app'
import toast from 'react-hot-toast'
import { kunFetchGet } from '~/utils/kunFetch'
import type { ButtonProps } from '@heroui/react'

type KunButtonProps = Omit<ButtonProps, 'startContent' | 'onPress'>

export const RandomGalgameButton = (props: KunButtonProps) => {
  const router = useRouter()

  const fetchRandomUniqueId = async () => {
    const response =
      await kunFetchGet<KunResponse<{ uniqueId: string }>>('/home/random')

    if (typeof response === 'string') {
      toast.error(response)
      return
    }

    return response.uniqueId
  }

  const handleRandomJump = async () => {
    const uniqueId = await fetchRandomUniqueId()
    if (uniqueId) {
      router.push(`/${uniqueId}`)
    }
  }

  return (
    <Button
      {...props}
      onPress={handleRandomJump}
      startContent={props.isIconOnly ? '' : <Dices size={18} />}
      aria-label={props.isIconOnly ? '随机一部游戏' : undefined}
    >
      {props.isIconOnly ? (
        <Dices className="text-default-500 size-6" />
      ) : (
        '随机一部游戏'
      )}
    </Button>
  )
}
