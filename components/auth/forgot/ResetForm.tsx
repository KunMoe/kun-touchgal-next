'use client'

import type { z } from 'zod'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { Button, Input } from '@heroui/react'
import { Card, CardBody, CardHeader } from '@heroui/card'
import { Divider } from '@heroui/react'
import { LockKeyhole } from 'lucide-react'
import type { forgotPasswordResetSchema } from '~/validations/forgot'
import { kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import toast from 'react-hot-toast'
import { useRouter } from '@bprogress/next/app'

type ResetFormData = z.infer<typeof forgotPasswordResetSchema>

interface Props {
  token: string
}

export const ResetForm = ({ token }: Props) => {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  const { control, watch, reset } = useForm<ResetFormData>({
    defaultValues: {
      token,
      newPassword: '',
      confirmPassword: ''
    }
  })

  const handleResetPassword = async (data: ResetFormData) => {
    if (data.newPassword !== data.confirmPassword) {
      toast.error('您两次输入的密码不一致, 请重新输入')
      return
    }

    setLoading(true)
    const res = await kunFetchPost<KunResponse<undefined>>('/forgot/reset', {
      ...data,
      token
    })
    kunErrorHandler(res, () => {
      reset()
      toast.success('重置密码成功! 正在跳转到登录页')
      router.push('/login')
    })
    setLoading(false)
  }

  return (
    <Card className="m-auto w-80">
      <CardHeader className="flex flex-col gap-2 p-6">
        <div className="mx-auto rounded-full bg-primary/10 p-3">
          <LockKeyhole className="size-6 text-primary" />
        </div>
        <h1 className="text-center text-2xl font-bold">设置新密码</h1>
        <p className="text-center text-sm text-default-500">
          请输入您的新密码, 设置成功后即可使用新密码登录
        </p>
      </CardHeader>
      <Divider />
      <CardBody className="space-y-4 p-6">
        <form className="space-y-4">
          <Controller
            name="newPassword"
            control={control}
            render={({ field }) => (
              <Input
                {...field}
                label="新密码"
                type="password"
                placeholder="请输入新密码"
                autoComplete="new-password"
                startContent={
                  <LockKeyhole className="size-4 text-default-400" />
                }
              />
            )}
          />
          <Controller
            name="confirmPassword"
            control={control}
            render={({ field }) => (
              <Input
                {...field}
                label="确认密码"
                type="password"
                placeholder="请再次输入新密码"
                autoComplete="new-password"
                startContent={
                  <LockKeyhole className="size-4 text-default-400" />
                }
              />
            )}
          />
          <Button
            color="primary"
            className="w-full"
            isLoading={loading}
            onPress={() => handleResetPassword(watch())}
          >
            确认重置密码
          </Button>
        </form>
      </CardBody>
    </Card>
  )
}
