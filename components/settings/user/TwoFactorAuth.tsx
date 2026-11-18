'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Switch,
  useDisclosure
} from '@heroui/react'
import { useUserStore } from '~/store/userStore'
import { kunFetchGet, kunFetchPost } from '~/utils/kunFetch'
import toast from 'react-hot-toast'
import { useMounted } from '~/hooks/useMounted'
import { kunErrorHandler } from '~/utils/kunErrorHandler'

interface AuthStatus {
  isEnabled2FA: boolean
  hasSecret: boolean
  backupCodeLength: number
  secret: string
  authUrl: string
  qrCodeUrl: string
  token: string
  backupCode: string[]
}

export const TwoFactorAuth = () => {
  const user = useUserStore((state) => state.user)
  const isMounted = useMounted()
  const [isPending, startTransition] = useTransition()

  const initialStatus: AuthStatus = {
    isEnabled2FA: false,
    hasSecret: false,
    backupCodeLength: 0,
    secret: '',
    authUrl: '',
    qrCodeUrl: '',
    token: '',
    backupCode: [] as string[]
  }
  const [authStatus, setAuthStatus] = useState<AuthStatus>(initialStatus)

  const { isOpen, onOpen, onClose } = useDisclosure()
  const {
    isOpen: isBackupOpen,
    onOpen: onBackupOpen,
    onClose: onBackupClose
  } = useDisclosure()
  const {
    isOpen: isDisableOpen,
    onOpen: onDisableOpen,
    onClose: onDisableClose
  } = useDisclosure()
  const [disableToken, setDisableToken] = useState('')
  const [isUsingBackupCode, setIsUsingBackupCode] = useState(false)
  // 生成密钥之前先确认当前密码
  const {
    isOpen: isPasswordOpen,
    onOpen: onPasswordOpen,
    onClose: onPasswordClose
  } = useDisclosure()
  const [currentPassword, setCurrentPassword] = useState('')

  useEffect(() => {
    const check2FAStatus = async () => {
      try {
        const response = await kunFetchGet<{
          enabled: boolean
          hasSecret: boolean
          backupCodeLength: number
        }>('/user/setting/2fa/status')
        setAuthStatus((current) => ({
          ...current,
          isEnabled2FA: response.enabled,
          hasSecret: response.hasSecret,
          backupCodeLength: response.backupCodeLength
        }))
      } catch {
        toast.error('读取 2FA 状态失败, 请稍后重试')
      }
    }

    if (isMounted) {
      check2FAStatus()
    }
  }, [isMounted])

  const closePasswordModal = () => {
    setCurrentPassword('')
    onPasswordClose()
  }

  const generateSecret = async () => {
    startTransition(async () => {
      try {
        const res = await kunFetchPost<
          KunResponse<{
            secret: string
            authUrl: string
            qrCodeUrl: string
          }>
        >('/user/setting/2fa/save-secret', { currentPassword })

        kunErrorHandler(res, (value) => {
          closePasswordModal()
          setAuthStatus((current) => ({
            ...current,
            secret: value.secret,
            authUrl: value.authUrl,
            qrCodeUrl: value.qrCodeUrl,
            hasSecret: true,
            backupCodeLength: 0
          }))
          onOpen()
          toast.success('密钥已生成，请使用身份验证器应用扫描二维码')
        })
      } catch {
        toast.error('生成 2FA 密钥失败, 请稍后重试')
      }
    })
  }

  const verifyAndEnable = async () => {
    if (!authStatus.token) {
      toast.error('请输入验证码')
      return
    }

    startTransition(async () => {
      try {
        const res = await kunFetchPost<KunResponse<{ backupCode: string[] }>>(
          '/user/setting/2fa/enable',
          { token: authStatus.token }
        )

        kunErrorHandler(res, (value) => {
          setAuthStatus((current) => ({
            ...current,
            isEnabled2FA: true,
            backupCodeLength: value.backupCode.length,
            backupCode: value.backupCode
          }))
          onClose()
          onBackupOpen()
          toast.success('两步验证已启用')
        })
      } catch {
        toast.error('启用 2FA 失败, 请稍后重试')
      }
    })
  }

  const closeDisableModal = () => {
    setDisableToken('')
    setIsUsingBackupCode(false)
    onDisableClose()
  }

  const disable2FA = async () => {
    const token = disableToken.trim()
    if (!token) {
      toast.error('请输入验证码')
      return
    }

    startTransition(async () => {
      try {
        const res = await kunFetchPost<KunResponse<{}>>(
          '/user/setting/2fa/disable',
          {
            token,
            isBackupCode: isUsingBackupCode
          }
        )

        kunErrorHandler(res, () => {
          setAuthStatus(initialStatus)
          closeDisableModal()
          toast.success('两步验证已禁用')
        })
      } catch {
        toast.error('关闭 2FA 失败, 请稍后重试')
      }
    })
  }

  return (
    <>
      <Card className="w-full overflow-hidden rounded-[22px] border border-default-200/60 bg-background text-sm shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
        <CardHeader className="flex-col items-start gap-1 px-5 pb-0 pt-5">
          <h2 className="text-xl font-semibold text-foreground">两步验证</h2>
          <p className="max-w-2xl leading-6 text-default-500">
            登录时除密码外再验证身份验证器验证码，为账户增加额外保护。
          </p>
        </CardHeader>
        <CardBody className="space-y-4 overflow-visible px-5 py-4">
          <div className="rounded-2xl border border-default-200 bg-default-50/70 p-4 dark:bg-default-100/10">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="font-medium text-foreground">是否启用两步验证</p>
                <p className="leading-6 text-default-500">
                  当前还有{' '}
                  <b className="font-semibold text-foreground">
                    {authStatus.backupCodeLength}
                  </b>{' '}
                  个备用验证码，过少时建议重新配置。
                </p>
              </div>
              <Switch
                size="lg"
                color="primary"
                aria-label="启用两步验证"
                isSelected={authStatus.isEnabled2FA}
                isDisabled={isPending}
                onValueChange={(value) => {
                  if (!value) {
                    onDisableOpen()
                  } else if (!user.uid) {
                    toast.error('请登录后再启用 2FA')
                  } else {
                    onPasswordOpen()
                  }
                }}
              />
            </div>
          </div>
        </CardBody>

        <CardFooter className="border-t border-default-100 bg-default-50/60 px-5 py-4 text-default-500 dark:bg-default-100/10">
          <p className="leading-6">
            启用后，即使密码泄露，他人也无法仅凭密码登录您的账户。
          </p>
        </CardFooter>
      </Card>

      <Modal isOpen={isPasswordOpen} onClose={closePasswordModal} size="md">
        <ModalContent>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault()
              generateSecret()
            }}
          >
            <ModalHeader>确认当前密码</ModalHeader>
            <ModalBody>
              <p className="text-sm text-default-500">
                为确认是您本人操作，生成两步验证密钥前请输入当前密码。
              </p>
              <Input
                isRequired
                type="password"
                name="current-password"
                label="当前密码"
                autoComplete="current-password"
                value={currentPassword}
                onValueChange={setCurrentPassword}
              />
            </ModalBody>
            <ModalFooter>
              <Button
                variant="light"
                onPress={closePasswordModal}
                isDisabled={isPending}
              >
                取消
              </Button>
              <Button color="primary" type="submit" isLoading={isPending}>
                继续
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>

      <Modal isOpen={isOpen} onClose={onClose} size="lg">
        <ModalContent>
          <ModalHeader>设置两步验证</ModalHeader>
          <ModalBody>
            <div className="space-y-6">
              <div className="space-y-2">
                <h3 className="text-lg font-medium">步骤 1: 扫描二维码</h3>
                <p className="text-sm text-default-500">
                  使用 Google Authenticator、Microsoft Authenticator
                  或其他身份验证器应用扫描下方的二维码
                </p>
                {authStatus.qrCodeUrl && (
                  <div className="flex justify-center my-4">
                    <img
                      src={authStatus.qrCodeUrl}
                      alt="两步验证二维码"
                      width={200}
                      height={200}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <h3 className="text-lg font-medium">步骤 2: 输入验证码</h3>
                <p className="text-sm text-default-500">
                  打开身份验证器应用，输入显示的 6 位验证码
                </p>
                <Input
                  value={authStatus.token}
                  onValueChange={(value) =>
                    setAuthStatus({ ...authStatus, token: value })
                  }
                  placeholder="6 位验证码"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  className="text-lg tracking-widest text-center"
                />
              </div>

              <div className="space-y-2">
                <h3 className="text-lg font-medium">密钥</h3>
                <p className="text-sm text-default-500">
                  如果无法扫描二维码，您可以手动将此密钥输入到身份验证器应用中
                </p>
                <div className="flex gap-2">
                  <Input
                    value={authStatus.secret}
                    readOnly
                    className="font-mono"
                  />
                  <Button
                    color="primary"
                    variant="flat"
                    onPress={() => {
                      navigator.clipboard.writeText(authStatus.secret)
                      toast.success('密钥已复制到剪贴板')
                    }}
                  >
                    复制
                  </Button>
                </div>
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button color="danger" variant="light" onPress={onClose}>
              取消
            </Button>
            <Button
              color="primary"
              onPress={verifyAndEnable}
              isLoading={isPending}
              isDisabled={isPending || !authStatus.token}
            >
              验证并启用
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={isDisableOpen} onClose={closeDisableModal} size="md">
        <ModalContent>
          <ModalHeader>关闭两步验证</ModalHeader>
          <ModalBody>
            <div className="space-y-4">
              <p className="text-sm text-default-500">
                请输入身份验证器应用中的 6 位验证码，或使用一个备用验证码。
              </p>
              <Input
                value={disableToken}
                onValueChange={setDisableToken}
                placeholder={
                  isUsingBackupCode ? '输入备用验证码' : '输入 6 位验证码'
                }
                maxLength={isUsingBackupCode ? 10 : 6}
                className="text-lg text-center"
              />
              <button
                type="button"
                className="relative inline-flex items-center text-medium text-primary no-underline transition-opacity outline-hidden tap-highlight-transparent hover:opacity-hover active:opacity-disabled disabled:cursor-not-allowed disabled:opacity-disabled focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2"
                onClick={() => {
                  setIsUsingBackupCode((value) => !value)
                  setDisableToken('')
                }}
                disabled={isPending}
              >
                {isUsingBackupCode ? '使用身份验证器验证码' : '使用备用验证码'}
                <svg
                  aria-hidden="true"
                  fill="none"
                  focusable="false"
                  height="1em"
                  shapeRendering="geometricPrecision"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                  viewBox="0 0 24 24"
                  width="1em"
                  className="self-center flex mx-1 text-current"
                >
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                  <path d="M15 3h6v6" />
                  <path d="M10 14L21 3" />
                </svg>
              </button>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button
              color="danger"
              variant="light"
              onPress={closeDisableModal}
              isDisabled={isPending}
            >
              取消
            </Button>
            <Button
              color="danger"
              onPress={disable2FA}
              isLoading={isPending}
              isDisabled={isPending || !disableToken.trim()}
            >
              验证并关闭
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isDismissable={false}
        isOpen={isBackupOpen}
        onClose={onBackupClose}
        size="lg"
      >
        <ModalContent>
          <ModalHeader>备用验证码</ModalHeader>
          <ModalBody>
            <div className="space-y-4">
              <p className="text-sm text-default-500">
                请保存这些备用验证码，每个代码只能使用一次。如果您无法使用身份验证器应用，可以使用这些备用码登录
              </p>
              <div className="grid grid-cols-3 gap-2">
                {authStatus.backupCode.map((code, index) => (
                  <Chip
                    key={index}
                    className="p-2 mx-auto font-mono text-center"
                    variant="flat"
                  >
                    {code}
                  </Chip>
                ))}
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button
              color="primary"
              onPress={() => {
                navigator.clipboard.writeText(authStatus.backupCode.join('\n'))
                toast.success('备用验证码已复制到剪贴板')
              }}
            >
              复制所有代码
            </Button>
            <Button color="primary" onPress={onBackupClose}>
              完成
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}
