import { useState } from 'react'
import { kunFetchPut } from '~/utils/kunFetch'
import { Button } from '@heroui/button'
import { Tooltip } from '@heroui/tooltip'
import { ThumbsUp } from 'lucide-react'
import { useUserStore } from '~/store/userStore'
import toast from 'react-hot-toast'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { cn } from '~/utils/cn'

// 受控: 点赞状态与计数归持有资源数据的宿主 (资源列表 / 资源详情页), 按钮只上报结果.
// 自己复制一份 useState 的话结果回不到宿主, 切分区重新挂载就按旧数据重新初始化
interface Props {
  resourceId: number
  authorId: number
  isLike: boolean
  likeCount: number
  isDisabled?: boolean
  onChange: (next: { isLike: boolean; likeCount: number }) => void
}

export const ResourceLikeButton = ({
  resourceId,
  authorId,
  isLike,
  likeCount,
  isDisabled,
  onChange
}: Props) => {
  const user = useUserStore((state) => state.user)

  const [loading, setLoading] = useState(false)

  const toggleLike = async () => {
    if (!user.uid) {
      toast.error('请登录以点赞')
      return
    }

    if (authorId === user.uid) {
      toast.error('您不能给自己点赞')
      return
    }

    setLoading(true)

    const res = await kunFetchPut<KunResponse<boolean>>(
      '/patch/resource/like',
      { resourceId }
    )

    setLoading(false)
    kunErrorHandler(res, (value) => {
      onChange({
        isLike: value,
        likeCount: value ? likeCount + 1 : likeCount - 1
      })
    })
  }

  return (
    <Tooltip key="like" color="default" content="点赞" placement="bottom">
      <Button
        variant="light"
        isDisabled={isDisabled || loading}
        onPress={toggleLike}
        className="min-w-0 px-2"
      >
        <ThumbsUp className={cn('w-4 h-4', isLike ? 'text-danger-500' : '')} />
        {likeCount}
      </Button>
    </Tooltip>
  )
}
