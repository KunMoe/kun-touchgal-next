'use client'

import { kunMoyuMoe } from '~/config/moyu-moe'
import { useMemo, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import type { z } from 'zod'
import { Button, Checkbox, Input, Link } from '@heroui/react'
import {
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem
} from '@heroui/dropdown'
import { ChevronDown } from 'lucide-react'
import { kunFetchPost } from '~/utils/kunFetch'
import type { registerSchema } from '~/validations/auth'
import { useUserStore } from '~/store/userStore'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import toast from 'react-hot-toast'
import { EmailVerification } from '~/components/kun/verification-code/Code'
import { useRouter } from '@bprogress/next/app'
import { KunTextDivider } from '~/components/kun/TextDivider'
import { KUN_EMAIL_DOMAIN_WHITELIST } from '~/constants/email/whitelist'
import type { UserState } from '~/store/userStore'

type RegisterFormData = z.infer<typeof registerSchema>

export const RegisterForm = () => {
  const setUser = useUserStore((state) => state.setUser)
  const router = useRouter()
  const [isAgree, setIsAgree] = useState(false)
  const [loading, setLoading] = useState(false)

  const [emailLocal, setEmailLocal] = useState('')
  const [emailDomain, setEmailDomain] = useState(KUN_EMAIL_DOMAIN_WHITELIST[0])

  const { control, watch, reset } = useForm<RegisterFormData>({
    defaultValues: {
      name: '',
      code: '',
      password: ''
    }
  })

  const fullEmail = useMemo(() => {
    const trimmed = emailLocal.trim()
    return trimmed ? `${trimmed}@${emailDomain}` : ''
  }, [emailLocal, emailDomain])

  const handleRegister = async () => {
    if (!isAgree) {
      toast.error('请您勾选同意我们的用户协议')
      return
    }

    setLoading(true)
    const { name, code, password } = watch()
    const res = await kunFetchPost<KunResponse<UserState>>('/auth/register', {
      name,
      email: fullEmail,
      code,
      password
    })

    setLoading(false)

    kunErrorHandler(res, (value) => {
      setUser(value)
      reset()
      setEmailLocal('')
      setEmailDomain(KUN_EMAIL_DOMAIN_WHITELIST[0])
      toast.success('注册成功!')
      router.push(`/user/${value.uid}/comment`, { scroll: false })
    })
  }

  return (
    <form className="flex flex-col space-y-4 w-80">
      <Controller
        name="name"
        control={control}
        render={({ field }) => (
          <Input
            {...field}
            isRequired
            label="用户名"
            type="name"
            variant="bordered"
            autoComplete="username"
          />
        )}
      />
      <div className="flex gap-2 items-start">
        <Input
          isRequired
          label="邮箱"
          type="text"
          variant="bordered"
          autoComplete="email"
          value={emailLocal}
          onValueChange={setEmailLocal}
          className="flex-1 min-w-0"
        />
        <Dropdown>
          <DropdownTrigger>
            <Button
              variant="bordered"
              className="w-40 h-14 shrink-0 justify-between text-medium font-normal text-foreground"
              endContent={<ChevronDown className="size-4 text-default-500" />}
            >
              @{emailDomain}
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label="邮箱域名"
            selectionMode="single"
            selectedKeys={new Set([emailDomain])}
            disallowEmptySelection
            onSelectionChange={(keys) => {
              const [key] = Array.from(keys)
              if (typeof key === 'string') {
                setEmailDomain(key)
              }
            }}
            className="max-h-72 overflow-y-auto"
          >
            {KUN_EMAIL_DOMAIN_WHITELIST.map((domain) => (
              <DropdownItem key={domain}>@{domain}</DropdownItem>
            ))}
          </DropdownMenu>
        </Dropdown>
      </div>
      <Controller
        name="code"
        control={control}
        render={({ field }) => (
          <Input
            {...field}
            isRequired
            label="验证码"
            type="text"
            variant="bordered"
            autoComplete="one-time-code"
            endContent={
              <EmailVerification
                username={watch().name}
                email={fullEmail}
                type="register"
              />
            }
          />
        )}
      />
      <Controller
        name="password"
        control={control}
        render={({ field }) => (
          <Input
            {...field}
            isRequired
            label="密码"
            type="password"
            variant="bordered"
            autoComplete="current-password"
          />
        )}
      />

      <div>
        <Checkbox isSelected={isAgree} onValueChange={setIsAgree}>
          <span>我同意</span>
        </Checkbox>
        <Link className="ml-1" href="/doc/notice/privacy">
          {kunMoyuMoe.titleShort} 用户协议
        </Link>
      </div>

      <Button
        color="primary"
        className="w-full"
        isLoading={loading}
        onPress={handleRegister}
      >
        注册
      </Button>

      <KunTextDivider text="或" dividerClass="my-4" />

      <Button
        color="primary"
        variant="bordered"
        className="w-full mb-4"
        onPress={() => router.push('/login')}
      >
        登录
      </Button>

      <div className="flex items-center">
        <span className="mr-2">忘记密码?</span>
        <Link href="/auth/forgot">重置密码</Link>
      </div>
    </form>
  )
}
