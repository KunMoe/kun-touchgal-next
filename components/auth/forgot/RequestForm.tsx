'use client'

import { useState } from 'react'
import * as z from 'zod'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button, Input, useDisclosure } from '@heroui/react'
import { Mail } from 'lucide-react'
import { kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { forgotPasswordRequestSchema } from '~/validations/forgot'
import { KunCaptchaModal } from '~/components/kun/auth/CaptchaModal'

type RequestFormData = z.infer<typeof forgotPasswordRequestSchema>

interface Props {
  setSent: (sent: boolean) => void
}

export const RequestForm = ({ setSent }: Props) => {
  const [loading, setLoading] = useState(false)
  const { isOpen, onOpen, onClose } = useDisclosure()

  const { control, watch, trigger } = useForm<RequestFormData>({
    resolver: zodResolver(forgotPasswordRequestSchema),
    defaultValues: {
      email: '',
      captcha: ''
    }
  })

  const handleCaptchaSuccess = async (code: string) => {
    onClose()
    setLoading(true)

    const data = watch()
    const res = await kunFetchPost<KunResponse<undefined>>('/forgot/request', {
      email: data.email,
      captcha: code
    })
    kunErrorHandler(res, () => {
      setSent(true)
    })

    setLoading(false)
  }

  const handleOpenCaptcha = async () => {
    setLoading(true)
    const valid = await trigger('email')
    setLoading(false)
    if (valid) {
      onOpen()
    }
  }

  return (
    <form className="w-full space-y-4">
      <Controller
        name="email"
        control={control}
        render={({ field, formState: { errors } }) => (
          <Input
            {...field}
            label="邮箱"
            placeholder="请输入您的邮箱"
            autoComplete="email"
            isInvalid={!!errors.email}
            errorMessage={errors.email?.message}
            startContent={<Mail className="size-4 text-default-400" />}
          />
        )}
      />
      <Button
        color="primary"
        className="w-full"
        isLoading={loading}
        isDisabled={loading || isOpen}
        onPress={handleOpenCaptcha}
      >
        发送重置链接
      </Button>

      <KunCaptchaModal
        isOpen={isOpen}
        onClose={onClose}
        onSuccess={handleCaptchaSuccess}
      />
    </form>
  )
}
