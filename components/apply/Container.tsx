'use client'

import { useState } from 'react'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { KunHeader } from '~/components/kun/Header'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Divider,
  Progress
} from '@heroui/react'
import { BadgeCheck, CheckCircle2, CircleSlash, Trophy } from 'lucide-react'
import { useRouter } from '@bprogress/next/app'
import { kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { Link } from '@heroui/react'
import toast from 'react-hot-toast'

interface Props {
  count: number
}

export const ApplyContainer = ({ count }: Props) => {
  const router = useRouter()
  const [applying, setApplying] = useState(false)

  const progress = Math.min((count / 3) * 100, 100)
  const canApply = count >= 3

  const handleApply = async () => {
    setApplying(true)
    try {
      const res = await kunFetchPost<KunResponse<{}>>('/apply')
      kunErrorHandler(res, () => {
        toast.success('恭喜您, 您的申请已成功提交')
        router.push('/apply/pending')
      })
    } catch {
      toast.error('提交申请失败, 请稍后重试')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="w-full px-4 mx-auto my-4">
      <KunHeader
        name="申请成为创作者"
        description="申请成为创作者以获得使用本站存储的权限"
      />

      <Card className="max-w-xl mx-auto mt-8 ">
        <CardHeader>
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Trophy className="text-warning" />
            创作者申请进度
          </h2>
        </CardHeader>
        <CardBody className="gap-6">
          <div className="flex items-center justify-between">
            <p className="text-default-500">发布资源进度: {count}/3</p>
            <Chip
              color={canApply ? 'success' : 'warning'}
              variant="flat"
              startContent={
                canApply ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <CircleSlash className="size-4" />
                )
              }
            >
              {canApply ? '已达到申请条件' : '请继续努力哦'}
            </Chip>
          </div>

          <Progress
            size="md"
            radius="sm"
            classNames={{
              base: 'max-w-full',
              indicator: 'bg-gradient-to-r from-danger-500 to-warning-500'
            }}
            value={progress}
            showValueLabel={true}
            aria-label="发布资源进度"
          />

          <Divider />

          <div className="space-y-4">
            <div>
              <h3 className="mb-2 text-lg font-semibold">申请条件</h3>
              <p className="text-default-500">在本站合法发布三个资源</p>
              <p className="text-default-500">
                详细信息请查看文档{' '}
                <Link href="/doc/notice/creator">
                  关于 {kunMoyuMoe.titleShort} 创作者
                </Link>
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-lg font-semibold">当前状态</h3>
              <p className="text-default-500">
                {canApply
                  ? '恭喜！您已经达到申请条件，可以立即申请成为创作者'
                  : `您还需要发布 ${3 - count} 个资源才能申请成为创作者`}
              </p>
            </div>
          </div>

          <Button
            color="primary"
            size="lg"
            startContent={<BadgeCheck className="size-5" />}
            isLoading={applying}
            isDisabled={!canApply || applying}
            onPress={handleApply}
            className="w-full"
          >
            {applying ? '申请处理中...' : '申请成为创作者'}
          </Button>
        </CardBody>
      </Card>
    </div>
  )
}
