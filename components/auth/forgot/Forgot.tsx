'use client'

import { useState } from 'react'
import { Card, CardBody, CardHeader } from '@heroui/card'
import { Button, Divider } from '@heroui/react'
import { LockKeyhole, MailCheck } from 'lucide-react'
import { useRouter } from '@bprogress/next/app'
import { RequestForm } from './RequestForm'

export const ForgotPassword = () => {
  const router = useRouter()
  const [sent, setSent] = useState(false)

  return (
    <Card className="m-auto w-80">
      <CardHeader className="flex flex-col gap-2 p-6">
        <div className="mx-auto rounded-full bg-primary/10 p-3">
          {sent ? (
            <MailCheck className="size-6 text-primary" />
          ) : (
            <LockKeyhole className="size-6 text-primary" />
          )}
        </div>
        <h1 className="text-center text-2xl font-bold">重置密码</h1>
        <p className="text-center text-sm text-default-500">
          {sent ? '重置密码请求已提交' : '输入您的邮箱以发送重置密码链接'}
        </p>
      </CardHeader>
      <Divider />
      <CardBody className="space-y-4 p-6">
        {sent ? (
          <>
            <p className="text-center text-sm text-default-500">
              如果该邮箱已注册，则将很快收到一封包含重置密码链接的邮件。
              <br />
              如果没有收到请检查垃圾邮件。
            </p>
            <Button
              color="primary"
              className="w-full"
              onPress={() => router.push('/login')}
            >
              返回登录
            </Button>
          </>
        ) : (
          <RequestForm setSent={setSent} />
        )}
      </CardBody>
    </Card>
  )
}
