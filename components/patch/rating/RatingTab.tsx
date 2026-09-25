'use client'

import { memo } from 'react'
import { Card, CardBody, CardHeader } from '@heroui/card'
import { Ratings } from '~/components/patch/rating/Ratings'

interface Props {
  id: number
  targetRatingId: number | null
}

export const RatingTab = memo(function RatingTab({
  id,
  targetRatingId
}: Props) {
  return (
    <Card className="p-1 sm:p-8">
      <CardHeader className="p-4">
        <h2 className="text-2xl font-medium">游戏评价</h2>
      </CardHeader>
      <CardBody className="p-4">
        <div className="space-y-2 text-default-600">
          <p>您可以发布对于这个游戏的看法, 建议填写一定字数的短评。</p>
        </div>

        <Ratings id={Number(id)} targetRatingId={targetRatingId} />
      </CardBody>
    </Card>
  )
})
