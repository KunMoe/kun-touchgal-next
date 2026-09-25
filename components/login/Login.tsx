'use client'

import { useTransition } from 'react'
import * as z from 'zod'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button, Input, Link, useDisclosure } from '@heroui/react'
import { kunFetchPost } from '~/utils/kunFetch'
import { loginSchema } from '~/validations/auth'
import { useUserStore } from '~/store/userStore'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { resolveKunLoginRedirect } from '~/utils/loginRedirect'
import { useRouter } from '@bprogress/next/app'
import toast from 'react-hot-toast'
import { KunCaptchaModal } from '~/components/kun/auth/CaptchaModal'
import { KunTextDivider } from '~/components/kun/TextDivider'
import type { UserState } from '~/store/userStore'

type LoginFormData = z.infer<typeof loginSchema>

export const LoginForm = () => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [isPending, startTransition] = useTransition()
  const setUser = useUserStore((state) => state.setUser)
  const router = useRouter()

  const { control, watch, reset } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      name: '',
      password: ''
    }
  })

  const handleCaptchaSuccess = async (code: string) => {
    startTransition(async () => {
      onClose()
      const res = await kunFetchPost<
        KunResponse<(UserState | KunUser) & { require2FA: boolean }>
      >('/auth/login', {
        ...watch(),
        captcha: code
      })

      kunErrorHandler(res, (value) => {
        if (value.require2FA) {
          router.push(`/login/2fa${window.location.search}`)
        } else {
          const state = value as UserState
          setUser(state)
          reset()
          toast.success('登录成功!')
          router.push(resolveKunLoginRedirect(window.location.search))
        }
      })
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isPending) {
      onOpen()
    }
  }

  return (
    <form className="w-72" onSubmit={handleSubmit}>
      <Controller
        name="name"
        control={control}
        render={({ field, formState: { errors } }) => (
          <Input
            {...field}
            isRequired
            label="用户名或邮箱"
            type="text"
            variant="bordered"
            autoComplete="username"
            isInvalid={!!errors.name}
            errorMessage={errors.name?.message}
            className="mb-4"
          />
        )}
      />
      <Controller
        name="password"
        control={control}
        render={({ field, formState: { errors } }) => (
          <Input
            {...field}
            isRequired
            label="密码"
            type="password"
            variant="bordered"
            isInvalid={!!errors.password}
            autoComplete="current-password"
            errorMessage={errors.password?.message}
            className="mb-4"
          />
        )}
      />
      <Button
        color="primary"
        className="w-full"
        type="submit"
        isDisabled={isPending}
        isLoading={isPending}
        onPress={onOpen}
      >
        登录
      </Button>

      <KunCaptchaModal
        isOpen={isOpen}
        onClose={onClose}
        onSuccess={handleCaptchaSuccess}
      />

      <KunTextDivider text="或" />

      <Button
        color="primary"
        variant="bordered"
        className="w-full mb-4"
        onPress={() => router.push('/register')}
      >
        注册
      </Button>

      <div className="flex items-center">
        <span className="mr-2">忘记密码?</span>
        <Link href="/auth/forgot">重置密码</Link>
      </div>
    </form>
  )
}
