'use client'

import { Button, Card, CardBody, CardFooter, CardHeader } from '@heroui/react'
import { AlertTriangle, ArrowLeft, Home, RefreshCw } from 'lucide-react'
import { useRouter } from '@bprogress/next/app'

interface ErrorComponentProps {
  error: string
  showReset?: boolean
  reset?: () => void
}

export const ErrorComponent = ({
  error,
  showReset = false,
  reset
}: ErrorComponentProps) => {
  const router = useRouter()

  return (
    <div className="flex items-center justify-center p-8 size-full">
      <Card className="w-full max-w-lg shadow-2xl">
        <CardHeader className="flex gap-3 px-8 pt-8">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-full bg-danger-50">
              <AlertTriangle className="size-8 text-danger" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">出错了</h1>
              <p className="text-default-500">发生了一些意外情况</p>
            </div>
          </div>
        </CardHeader>
        <CardBody className="px-8">
          <div className="p-4 mt-4 rounded-lg bg-danger-50">
            <p className="font-mono text-sm text-danger">{error}</p>
          </div>
        </CardBody>
        <CardFooter className="flex flex-wrap gap-2 px-8 pb-8">
          <Button
            startContent={<ArrowLeft className="size-4" />}
            variant="flat"
            color="primary"
            onPress={() => router.back()}
          >
            返回上一页
          </Button>
          {showReset && (
            <Button
              startContent={<RefreshCw className="size-4" />}
              variant="flat"
              color="primary"
              onPress={() => reset?.()}
            >
              重试
            </Button>
          )}
          <Button
            startContent={<Home className="size-4" />}
            color="primary"
            onPress={() => router.push('/')}
          >
            返回首页
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
