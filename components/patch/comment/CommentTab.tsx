'use client'

import { memo } from 'react'
import { Card, CardBody, CardHeader } from '@heroui/card'
import { Comments } from '~/components/patch/comment/Comments'

interface Props {
  id: number
  targetCommentId: number | null
}

export const CommentTab = memo(function CommentTab({
  id,
  targetCommentId
}: Props) {
  return (
    <Card className="p-1 sm:p-8">
      <CardHeader className="p-4">
        <h2 className="text-2xl font-medium">游戏评论</h2>
      </CardHeader>
      <CardBody className="p-4">
        <div className="space-y-2 text-default-600">
          <p className="mb-4">
            您可以在这里发表关于本游戏评论, 或者反馈错误,
            注意不要发布违反您当地法律法规的内容, 和谐交流。
          </p>
        </div>

        <Comments id={Number(id)} targetCommentId={targetCommentId} />
      </CardBody>
    </Card>
  )
})
