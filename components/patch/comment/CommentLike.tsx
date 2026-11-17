import { SetStateAction, useState } from 'react'
import { kunFetchPut } from '~/utils/kunFetch'
import { Button } from '@heroui/button'
import { Tooltip } from '@heroui/tooltip'
import { ThumbsUp } from 'lucide-react'
import { useUserStore } from '~/store/userStore'
import toast from 'react-hot-toast'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { cn } from '~/utils/cn'
import { updateCommentLike } from './updateCommentLike'
import type { PatchComment } from '~/types/api/patch'

interface Props {
  comment: PatchComment
  setComments: (comments: SetStateAction<PatchComment[]>) => void
  isDisabled?: boolean
}

// 点赞状态不留在本地: 楼中楼翻页 / 收起会把本按钮卸载再挂载, 结果一律写回评论树
export const CommentLikeButton = ({
  comment,
  setComments,
  isDisabled
}: Props) => {
  const user = useUserStore((state) => state.user)
  const [loading, setLoading] = useState(false)

  const toggleLike = async () => {
    if (!user.uid) {
      toast.error('请登录以点赞')
      return
    }

    if (comment.user.id === user.uid) {
      toast.error('您不能给自己点赞')
      return
    }

    setLoading(true)
    const res = await kunFetchPut<KunResponse<boolean>>('/patch/comment/like', {
      commentId: comment.id
    })

    setLoading(false)
    kunErrorHandler(res, (value) => {
      setComments((prev) => updateCommentLike(prev, comment.id, value))
    })
  }

  return (
    <Tooltip key="like" color="default" content="点赞" placement="bottom">
      <Button
        variant="ghost"
        size="sm"
        className="gap-2"
        isDisabled={isDisabled}
        isLoading={loading}
        onPress={toggleLike}
      >
        <ThumbsUp
          className={cn('w-4 h-4', comment.isLike ? 'text-danger-500' : '')}
        />
        {comment.likeCount}
      </Button>
    </Tooltip>
  )
}
