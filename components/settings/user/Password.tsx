'use client'

import { useState } from 'react'
import * as z from 'zod'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Card, CardBody, CardFooter, CardHeader } from '@heroui/card'
import { Input } from '@heroui/input'
import { Button } from '@heroui/button'
import { Divider } from '@heroui/divider'
import { Link } from '@heroui/link'
import { useRouter } from '@bprogress/next'
import toast from 'react-hot-toast'
import { passwordSchema } from '~/validations/user'
import { kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { useUserStore } from '~/store/userStore'
type PasswordFormData = z.infer<typeof passwordSchema>

export const Password = () => {
  const router = useRouter()
  const logout = useUserStore((state) => state.logout)
  const [loading, setLoading] = useState(false)

  const {
    control,
    formState: { errors },
    reset,
    handleSubmit
  } = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema),
    defaultValues: {
      oldPassword: '',
      newPassword: ''
    }
  })

  const handleUpdatePassword = async (data: PasswordFormData) => {
    setLoading(true)

    try {
      const res = await kunFetchPost<KunResponse<{}>>(
        '/user/setting/password',
        data
      )
      kunErrorHandler(res, () => {
        reset()
        logout()
        toast.success('更改密码成功, 请使用新密码重新登录')
        router.push('/login')
      })
    } catch {
      toast.error('更改密码失败, 请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="w-full overflow-hidden rounded-[22px] border border-default-200/60 bg-background text-sm shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
      <form className="contents" onSubmit={handleSubmit(handleUpdatePassword)}>
        <CardHeader className="flex-col items-start gap-1 px-5 pb-0 pt-5">
          <h2 className="text-xl font-semibold text-foreground">密码</h2>
          <p className="max-w-2xl leading-6 text-default-500">
            输入当前密码后设置新密码，保存成功后需要重新登录。
          </p>
        </CardHeader>
        <CardBody className="space-y-4 overflow-visible px-5 py-4">
          <Controller
            name="oldPassword"
            control={control}
            render={({ field }) => (
              <Input
                {...field}
                type="password"
                label="旧密码"
                autoComplete="current-password"
                isInvalid={!!errors.oldPassword}
                errorMessage={errors.oldPassword?.message}
              />
            )}
          />
          <Controller
            name="newPassword"
            control={control}
            render={({ field }) => (
              <Input
                {...field}
                type="password"
                label="新密码"
                autoComplete="new-password"
                isInvalid={!!errors.newPassword}
                errorMessage={errors.newPassword?.message}
              />
            )}
          />
        </CardBody>

        <CardFooter className="flex flex-col items-start gap-3 border-t border-default-100 bg-default-50/60 px-5 py-4 sm:flex-row sm:items-center dark:bg-default-100/10">
          <p className="min-w-0 flex-1 leading-6 text-default-500">
            密码长度为 6 到 1000 个字符，至少包含数字和英语字母，可包含
            @!#$%^&*()_-+=\/ 等特殊字符。
          </p>
          <Button
            color="primary"
            variant="solid"
            className="w-full sm:ml-auto sm:w-auto"
            type="submit"
            isLoading={loading}
          >
            保存
          </Button>
        </CardFooter>

        <Divider />

        <CardFooter className="justify-end px-5 py-3">
          <Link showAnchorIcon href="/auth/forgot" className="text-sm">
            忘记密码?
          </Link>
        </CardFooter>
      </form>
    </Card>
  )
}
