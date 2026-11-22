'use client'

import { useState } from 'react'
import { useRouter } from '@bprogress/next/app'
import { UserFollow } from './Follow'

interface Props {
  uid: number
  name: string
  isFollow: boolean
}

// 用户主页 (/user/[id]) 的关注按钮。UserFollow 受控, 关注状态归这里; 关注 / 取关成功后
// 刷新路由, 让服务端渲染的「人关注 TA」计数跟上。资料卡本身保持 Server Component
export const ProfileFollow = ({ uid, name, isFollow: initial }: Props) => {
  const router = useRouter()
  const [isFollow, setIsFollow] = useState(initial)

  return (
    <UserFollow
      uid={uid}
      name={name}
      isFollow={isFollow}
      onChange={(next) => {
        setIsFollow(next)
        router.refresh()
      }}
    />
  )
}
