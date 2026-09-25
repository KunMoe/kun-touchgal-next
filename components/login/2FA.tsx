'use client'

import { type FormEvent, useEffect, useState, useTransition } from 'react'
import { useRouter } from '@bprogress/next/app'
import { Button, Input } from '@heroui/react'
import toast from 'react-hot-toast'
import { useUserStore } from '~/store/userStore'
import { kunFetchGet, kunFetchPost } from '~/utils/kunFetch'
import { resolveKunLoginRedirect } from '~/utils/loginRedirect'
import { UserState } from '~/store/userStore'
import { KunTextDivider } from '~/components/kun/TextDivider'
import type { KunGalgameStatelessPayload } from '~/app/api/utils/jwt'

export const TwoFactor = () => {
  const [token, setToken] = useState('')
  const [isUsingBackupCode, setIsUsingBackupCode] = useState(false)
  const router = useRouter()
  const setUser = useUserStore((state) => state.setUser)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    const checkTempToken = async () => {
      const res = await kunFetchGet<KunResponse<KunGalgameStatelessPayload>>(
        '/auth/check-temp-token'
      )
      if (typeof res === 'string') {
        router.push(`/login${window.location.search}`)
      }
    }

    checkTempToken()
  }, [router])

  const handleSubmit = async () => {
    if (!token) {
      toast.error('请输入验证码')
      return
    }

    startTransition(async () => {
      const response = await kunFetchPost<UserState>('/auth/verify-2fa', {
        token,
        isBackupCode: isUsingBackupCode
      })

      if (typeof response === 'string') {
        toast.error(response)
      } else {
        setUser(response)
        toast.success('验证成功，欢迎回来！')
        router.push(resolveKunLoginRedirect(window.location.search))
      }
    })
  }

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void handleSubmit()
  }

  return (
    <form className="space-y-4 w-72" noValidate onSubmit={handleFormSubmit}>
      <p className="text-default-500">
        {isUsingBackupCode
          ? '请输入您的备用验证码'
          : '请输入身份验证器应用中显示的验证码'}
      </p>

      <Input
        isRequired
        label={isUsingBackupCode ? '备用验证码' : '6 位验证码'}
        value={token}
        onValueChange={setToken}
        variant="bordered"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
      />

      <Button
        type="submit"
        color="primary"
        className="w-full"
        isLoading={isPending}
        isDisabled={isPending}
      >
        {isPending ? '验证中...' : '验证'}
      </Button>

      <KunTextDivider dividerClass="my-4" text="或" />

      <Button
        type="button"
        color="primary"
        variant="bordered"
        className="w-full"
        onPress={() => setIsUsingBackupCode(!isUsingBackupCode)}
      >
        {isUsingBackupCode ? '使用身份验证器应用' : '使用备用验证码'}
      </Button>
    </form>
  )
}
