'use client'

import { useState } from 'react'
import { Button } from '@heroui/react'
import { Dices } from 'lucide-react'
import { useRouter } from '@bprogress/next/app'
import toast from 'react-hot-toast'
import { kunFetchGet } from '~/utils/kunFetch'
import type { ButtonProps } from '@heroui/react'

type KunButtonProps = Omit<ButtonProps, 'startContent' | 'onPress'>

export const RandomGalgameButton = (props: KunButtonProps) => {
  const router = useRouter()
  // 进度条要等 push 才启动, 取随机 id 这一个往返期间由按钮自身显示 loading
  const [isLoading, setIsLoading] = useState(false)

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
    setIsLoading(true)
    try {
      const uniqueId = await fetchRandomUniqueId()
      if (uniqueId) {
        router.push(`/${uniqueId}`)
      }
    } catch {
      toast.error('获取随机游戏失败, 请稍后重试')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Button
      {...props}
      isLoading={isLoading}
      onPress={handleRandomJump}
      startContent={props.isIconOnly || isLoading ? '' : <Dices size={18} />}
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
