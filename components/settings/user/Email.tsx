'use client'

import { useState } from 'react'
import * as z from 'zod'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Card, CardBody, CardFooter, CardHeader } from '@heroui/card'
import { Input } from '@heroui/input'
import { Button } from '@heroui/button'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import { KeyRound, Mail, ShieldCheck } from 'lucide-react'
import { EmailVerification } from '~/components/kun/verification-code/Code'
import { resetEmailSchema } from '~/validations/user'
import { kunFetchGet, kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import toast from 'react-hot-toast'

type EmailFormData = z.infer<typeof resetEmailSchema>

export const Email = () => {
  const [loading, setLoading] = useState(false)
  const [checkingAuthMode, setCheckingAuthMode] = useState(false)
  // 启用了两步验证的账号, 除当前密码外还要第二因子 (验证码或一个备用验证码)
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false)
  const [isUsingBackupCode, setIsUsingBackupCode] = useState(false)
  const { isOpen, onOpen, onClose } = useDisclosure()

  const {
    control,
    formState: { errors },
    handleSubmit,
    watch,
    setValue,
    reset
  } = useForm<EmailFormData>({
    resolver: zodResolver(resetEmailSchema),
    defaultValues: {
      email: '',
      code: '',
      currentPassword: '',
      totp: '',
      backupCode: ''
    }
  })

  const clearSecondFactor = () => {
    setValue('totp', '')
    setValue('backupCode', '')
  }

  const closeAuthModal = () => {
    setValue('currentPassword', '')
    clearSecondFactor()
    setIsUsingBackupCode(false)
    onClose()
  }

  const openAuthModal = async () => {
    setCheckingAuthMode(true)

    try {
      const response = await kunFetchGet<{
        enabled: boolean
        hasSecret: boolean
      }>('/user/setting/2fa/status')

      setNeedsSecondFactor(response.enabled)
      onOpen()
    } catch {
      toast.error('读取 2FA 状态失败, 请稍后重试')
    } finally {
      setCheckingAuthMode(false)
    }
  }

  const handleUpdateEmail = async (data: EmailFormData) => {
    setLoading(true)

    try {
      const res = await kunFetchPost<KunResponse<{}>>(
        '/user/setting/email',
        data
      )
      kunErrorHandler(res, () => {
        reset()
        setIsUsingBackupCode(false)
        onClose()
        toast.success('更新邮箱成功!')
      })
    } catch {
      toast.error('更新邮箱失败, 请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Card className="w-full overflow-hidden rounded-[22px] border border-default-200/60 bg-background text-sm shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
        <form className="contents" onSubmit={handleSubmit(openAuthModal)}>
          <CardHeader className="flex-col items-start gap-1 px-5 pb-0 pt-5">
            <h2 className="text-xl font-semibold text-foreground">邮箱</h2>
            <p className="max-w-2xl leading-6 text-default-500">
              邮箱用于密码恢复和重要安全通知，请确保可以正常接收邮件。
            </p>
          </CardHeader>
          <CardBody className="space-y-4 overflow-visible px-5 py-4">
            <div className="rounded-2xl border border-default-200 bg-default-50/70 p-4 dark:bg-default-100/10">
              <p className="font-medium text-foreground">验证流程</p>
              <p className="mt-1 leading-6 text-default-500">
                先向新邮箱发送验证码，保存时再输入当前密码确认本人操作；已启用两步验证的账户还需要
                2FA 验证码。
              </p>
            </div>
            <Controller
              name="email"
              control={control}
              render={({ field }) => (
                <Input
                  {...field}
                  type="email"
                  label="新邮箱"
                  placeholder="请输入您的新邮箱"
                  autoComplete="email"
                  startContent={
                    <Mail className="text-2xl pointer-events-none shrink-0 text-default-400" />
                  }
                  isInvalid={!!errors.email}
                  errorMessage={errors.email?.message}
                />
              )}
            />
            <Controller
              name="code"
              control={control}
              render={({ field }) => (
                <Input
                  {...field}
                  type="text"
                  label="新邮箱验证码"
                  placeholder="输入邮箱验证码"
                  autoComplete="one-time-code"
                  startContent={
                    <KeyRound className="text-2xl pointer-events-none shrink-0 text-default-400" />
                  }
                  endContent={
                    <EmailVerification
                      username=""
                      email={watch().email}
                      type="email"
                    />
                  }
                  isInvalid={!!errors.code}
                  errorMessage={errors.code?.message}
                />
              )}
            />
          </CardBody>
          <CardFooter className="flex flex-col items-start gap-3 border-t border-default-100 bg-default-50/60 px-5 py-4 sm:flex-row sm:items-center dark:bg-default-100/10">
            <p className="min-w-0 flex-1 leading-6 text-default-500">
              如果新邮箱未收到验证码，请检查垃圾邮件或全部邮件。
            </p>
            <Button
              color="primary"
              variant="solid"
              className="w-full sm:ml-auto sm:w-auto"
              type="submit"
              isLoading={checkingAuthMode}
              isDisabled={loading}
            >
              保存
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Modal isOpen={isOpen} onClose={closeAuthModal} placement="center">
        <ModalContent>
          <form className="contents" onSubmit={handleSubmit(handleUpdateEmail)}>
            <ModalHeader>确认修改邮箱</ModalHeader>
            <ModalBody>
              <p className="text-sm text-default-500">
                {needsSecondFactor
                  ? '请输入当前密码和 2FA 验证码以确认是您本人操作。'
                  : '请输入当前密码以确认是您本人操作。'}
              </p>
              <Controller
                name="currentPassword"
                control={control}
                render={({ field }) => (
                  <Input
                    {...field}
                    isRequired
                    type="password"
                    label="当前密码"
                    autoComplete="current-password"
                    startContent={
                      <KeyRound className="text-2xl pointer-events-none shrink-0 text-default-400" />
                    }
                    isInvalid={!!errors.currentPassword}
                    errorMessage={errors.currentPassword?.message}
                  />
                )}
              />
              {needsSecondFactor &&
                (isUsingBackupCode ? (
                  <Controller
                    name="backupCode"
                    control={control}
                    render={({ field }) => (
                      <Input
                        {...field}
                        isRequired
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        label="备用验证码"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck="false"
                        startContent={
                          <ShieldCheck className="text-2xl pointer-events-none shrink-0 text-default-400" />
                        }
                        isInvalid={!!errors.backupCode}
                        errorMessage={errors.backupCode?.message}
                      />
                    )}
                  />
                ) : (
                  <Controller
                    name="totp"
                    control={control}
                    render={({ field }) => (
                      <Input
                        {...field}
                        isRequired
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        label="2FA 验证码"
                        autoComplete="one-time-code"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck="false"
                        startContent={
                          <ShieldCheck className="text-2xl pointer-events-none shrink-0 text-default-400" />
                        }
                        isInvalid={!!errors.totp}
                        errorMessage={errors.totp?.message}
                      />
                    )}
                  />
                ))}
              {needsSecondFactor && (
                <Button
                  size="sm"
                  variant="light"
                  color="primary"
                  className="self-start"
                  isDisabled={loading}
                  onPress={() => {
                    clearSecondFactor()
                    setIsUsingBackupCode((value) => !value)
                  }}
                >
                  {isUsingBackupCode
                    ? '使用身份验证器验证码'
                    : '使用备用验证码'}
                </Button>
              )}
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={closeAuthModal}>
                取消
              </Button>
              <Button color="primary" type="submit" isLoading={loading}>
                确认修改
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
    </>
  )
}
