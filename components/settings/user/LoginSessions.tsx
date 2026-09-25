'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from '@bprogress/next/app'
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Chip,
  Divider,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Skeleton,
  Tooltip,
  useDisclosure
} from '@heroui/react'
import {
  AlertTriangle,
  CalendarClock,
  Clock3,
  Laptop,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2
} from 'lucide-react'
import toast from 'react-hot-toast'
import { kunFetchDelete, kunFetchGet, kunFetchPost } from '~/utils/kunFetch'
import { formatDate } from '~/utils/time'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { useUserStore } from '~/store/userStore'
import { useMessageStore } from '~/store/messageStore'
import { useSettingStore } from '~/store/settingStore'
import { cn } from '~/utils/cn'
import type {
  LoginSession,
  RevokeLoginSessionResponse,
  RevokeOtherLoginSessionsResponse
} from '~/types/api/session'

const USER_AGENT_PREVIEW_LENGTH = 140
const SESSION_SKELETON_COUNT = 2

type ConfirmMode = 'session' | 'others'

const getSessionDeviceInfo = (userAgent: string) => {
  if (!userAgent) {
    return {
      label: '未知设备',
      fullUserAgent: '未知 User-Agent',
      isMobile: false
    }
  }

  const normalized = userAgent.toLowerCase()
  const browser = normalized.includes('edg/')
    ? 'Edge'
    : normalized.includes('firefox/')
      ? 'Firefox'
      : normalized.includes('chrome/') || normalized.includes('crios/')
        ? 'Chrome'
        : normalized.includes('safari/')
          ? 'Safari'
          : '浏览器'
  const os =
    normalized.includes('iphone') || normalized.includes('ipad')
      ? 'iOS'
      : normalized.includes('android')
        ? 'Android'
        : normalized.includes('mac os')
          ? 'macOS'
          : normalized.includes('windows')
            ? 'Windows'
            : normalized.includes('linux')
              ? 'Linux'
              : '未知系统'
  const isMobile =
    normalized.includes('mobile') ||
    normalized.includes('iphone') ||
    normalized.includes('ipad') ||
    normalized.includes('android')

  return {
    label: `${browser} · ${os}`,
    fullUserAgent: userAgent,
    isMobile
  }
}

const getUserAgentPreview = (userAgent: string) => {
  if (!userAgent) {
    return '未知 User-Agent'
  }

  if (userAgent.length <= USER_AGENT_PREVIEW_LENGTH) {
    return userAgent
  }

  return `${userAgent.slice(0, USER_AGENT_PREVIEW_LENGTH)}...`
}

const LoginSessionSkeleton = () => (
  <div className="rounded-large border border-divider bg-content2/40 p-4">
    <div className="flex gap-3">
      <Skeleton className="size-11 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="w-full space-y-2">
            <Skeleton className="h-5 w-40 rounded-medium" />
            <Skeleton className="h-4 w-full rounded-medium" />
          </div>
          <Skeleton className="h-9 w-20 rounded-medium" />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Skeleton className="h-12 rounded-medium" />
          <Skeleton className="h-12 rounded-medium" />
          <Skeleton className="h-12 rounded-medium" />
        </div>
      </div>
    </div>
  </div>
)

const SessionMetaItem = ({
  icon,
  label,
  value,
  className
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  className?: string
}) => (
  <div
    className={cn(
      'rounded-medium border border-divider/70 bg-default-50/70 px-3 py-2 dark:bg-default-100/10',
      className
    )}
  >
    <div className="flex items-center gap-2 text-default-500">
      {icon}
      <span className="text-xs">{label}</span>
    </div>
    <p className="mt-1 break-words text-sm font-medium text-foreground">
      {value}
    </p>
  </div>
)

const LoginSessionCard = ({
  session,
  revokingSessionId,
  revokingOthers,
  onRevoke
}: {
  session: LoginSession
  revokingSessionId: string
  revokingOthers: boolean
  onRevoke: (session: LoginSession) => void
}) => {
  const device = getSessionDeviceInfo(session.userAgent)
  const DeviceIcon = device.isMobile ? Smartphone : Laptop
  const lastActive = (
    <>
      {formatDate(session.lastActiveAt, {
        isShowYear: true,
        isPrecise: true
      })}{' '}
      · <KunTimeAgo date={session.lastActiveAt} />
    </>
  )

  return (
    <article
      className={cn(
        'rounded-large border p-4 transition-colors duration-200',
        session.isCurrent
          ? 'border-primary/40 bg-primary/5 shadow-sm shadow-primary/10'
          : 'border-divider bg-content1 hover:border-default-300 hover:bg-content2/50'
      )}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 gap-3">
          <div
            className={cn(
              'flex size-11 shrink-0 items-center justify-center rounded-full border',
              session.isCurrent
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-divider bg-default-100 text-default-500'
            )}
            aria-hidden="true"
          >
            <DeviceIcon className="size-5" />
          </div>

          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-foreground">
                {device.label}
              </h3>
              {session.isCurrent ? (
                <Chip
                  color="primary"
                  variant="flat"
                  size="sm"
                  startContent={<ShieldCheck className="size-3.5" />}
                >
                  当前设备
                </Chip>
              ) : (
                <Chip color="default" variant="flat" size="sm">
                  已登录
                </Chip>
              )}
            </div>

            <Tooltip
              showArrow
              content={device.fullUserAgent}
              placement="top-start"
              closeDelay={0}
            >
              <p className="cursor-help break-all text-sm leading-6 text-default-500">
                {getUserAgentPreview(session.userAgent)}
              </p>
            </Tooltip>
          </div>
        </div>

        {!session.isCurrent && (
          <Button
            color="danger"
            variant="flat"
            size="sm"
            startContent={<Trash2 className="size-4" />}
            isDisabled={!!revokingSessionId || revokingOthers}
            isLoading={revokingSessionId === session.id}
            onPress={() => onRevoke(session)}
            aria-label={`撤销 ${device.label} 登录会话`}
          >
            撤销
          </Button>
        )}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <SessionMetaItem
          icon={<MapPin className="size-4" />}
          label="登录 IP"
          value={session.ip || '未知 IP'}
        />
        <SessionMetaItem
          icon={<Clock3 className="size-4" />}
          label="最近活跃"
          value={lastActive}
          className="sm:col-span-2 lg:col-span-1"
        />
        <SessionMetaItem
          icon={<CalendarClock className="size-4" />}
          label="创建时间"
          value={formatDate(session.createdAt, {
            isShowYear: true,
            isPrecise: true
          })}
        />
      </div>
    </article>
  )
}

export const LoginSessions = () => {
  const router = useRouter()
  const logout = useUserStore((state) => state.logout)
  const resetUnreadMessageStatus = useMessageStore(
    (state) => state.resetUnreadMessageStatus
  )
  const resetSettings = useSettingStore((state) => state.resetData)
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [sessions, setSessions] = useState<LoginSession[]>([])
  const [loading, setLoading] = useState(false)
  const [revokingSessionId, setRevokingSessionId] = useState('')
  const [revokingOthers, setRevokingOthers] = useState(false)
  const [selectedSession, setSelectedSession] = useState<LoginSession | null>(
    null
  )
  const [confirmMode, setConfirmMode] = useState<ConfirmMode | null>(null)

  const refreshSessions = async () => {
    setLoading(true)
    try {
      const response = await kunFetchGet<KunResponse<LoginSession[]>>(
        '/user/setting/session'
      )
      if (typeof response === 'string') {
        toast.error(response)
      } else {
        setSessions(response)
      }
    } catch {
      toast.error('读取登录会话失败, 请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refreshSessions()
  }, [])

  const isRevoking = !!revokingSessionId || revokingOthers
  const otherSessionCount = sessions.filter(
    (session) => !session.isCurrent
  ).length
  const currentSession = sessions.find((session) => session.isCurrent)

  const closeRevokeModal = () => {
    if (isRevoking) {
      return
    }

    setSelectedSession(null)
    setConfirmMode(null)
    onClose()
  }

  const openRevokeModal = (session: LoginSession) => {
    setSelectedSession(session)
    setConfirmMode('session')
    onOpen()
  }

  const openRevokeOthersModal = () => {
    setSelectedSession(null)
    setConfirmMode('others')
    onOpen()
  }

  const handleRevokeSession = async () => {
    if (!selectedSession) {
      return
    }

    setRevokingSessionId(selectedSession.id)
    try {
      const response = await kunFetchDelete<
        KunResponse<RevokeLoginSessionResponse>
      >('/user/setting/session', { sessionId: selectedSession.id })
      if (typeof response === 'string') {
        toast.error(response)
        return
      }

      if (response.revokedCurrent) {
        logout()
        resetUnreadMessageStatus()
        resetSettings()
        toast.success('当前登录会话已撤销, 请重新登录')
        router.push('/login')
        return
      }

      setSessions((prev) =>
        prev.filter((session) => session.id !== selectedSession.id)
      )
      toast.success('已撤销该登录会话')
      closeRevokeModal()
    } catch {
      toast.error('撤销登录会话失败, 请稍后重试')
    } finally {
      setRevokingSessionId('')
    }
  }

  const handleRevokeOtherSessions = async () => {
    setRevokingOthers(true)
    try {
      const response = await kunFetchPost<
        KunResponse<RevokeOtherLoginSessionsResponse>
      >('/user/setting/session')
      if (typeof response === 'string') {
        toast.error(response)
        return
      }

      setSessions((prev) => prev.filter((session) => session.isCurrent))
      toast.success(
        response.revokedCount
          ? `已撤销 ${response.revokedCount} 个其它登录会话`
          : '当前没有其它登录会话'
      )
      closeRevokeModal()
    } catch {
      toast.error('撤销其它登录会话失败, 请稍后重试')
    } finally {
      setRevokingOthers(false)
    }
  }

  const handleConfirmRevoke = () => {
    if (confirmMode === 'others') {
      handleRevokeOtherSessions()
    } else {
      handleRevokeSession()
    }
  }

  const selectedDevice = selectedSession
    ? getSessionDeviceInfo(selectedSession.userAgent)
    : null

  return (
    <Card className="w-full overflow-hidden rounded-[22px] border border-default-200/60 bg-background text-sm shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
      <CardHeader className="flex-col items-start gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div>
            <h2 className="text-xl font-semibold text-foreground">登录会话</h2>
            <p className="mt-1 max-w-2xl leading-6 text-default-500">
              管理已登录设备。发现陌生设备时，先撤销对应会话，再修改密码。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Chip variant="flat" color="primary" size="sm">
              {sessions.length} 个活动会话
            </Chip>
            <Chip
              variant="flat"
              color={otherSessionCount ? 'warning' : 'default'}
              size="sm"
            >
              {otherSessionCount
                ? `${otherSessionCount} 个其它设备`
                : '仅当前设备'}
            </Chip>
          </div>
        </div>

        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end">
          <Tooltip showArrow content="刷新登录会话" closeDelay={0}>
            <Button
              isIconOnly
              variant="flat"
              isDisabled={loading || isRevoking}
              isLoading={loading}
              onPress={refreshSessions}
              aria-label="刷新登录会话"
            >
              <RefreshCw className="size-4" />
            </Button>
          </Tooltip>
          <Button
            color="danger"
            variant="flat"
            startContent={<Trash2 className="size-4" />}
            isDisabled={loading || isRevoking || !otherSessionCount}
            isLoading={revokingOthers}
            onPress={openRevokeOthersModal}
          >
            撤销其它会话
          </Button>
        </div>
      </CardHeader>

      <Divider />

      <CardBody className="space-y-3 overflow-visible p-4 sm:p-5">
        {loading ? (
          Array.from({ length: SESSION_SKELETON_COUNT }).map((_, index) => (
            <LoginSessionSkeleton key={index} />
          ))
        ) : sessions.length ? (
          <>
            {currentSession && (
              <LoginSessionCard
                session={currentSession}
                revokingSessionId={revokingSessionId}
                revokingOthers={revokingOthers}
                onRevoke={openRevokeModal}
              />
            )}
            {sessions
              .filter((session) => !session.isCurrent)
              .map((session) => (
                <LoginSessionCard
                  key={session.id}
                  session={session}
                  revokingSessionId={revokingSessionId}
                  revokingOthers={revokingOthers}
                  onRevoke={openRevokeModal}
                />
              ))}

            {!otherSessionCount && (
              <div className="rounded-large border border-dashed border-divider bg-default-50/60 p-4 text-default-500 dark:bg-default-100/10">
                当前没有其它登录会话。若你刚在其它设备登录，可点击右上角刷新。
              </div>
            )}
          </>
        ) : (
          <div className="rounded-large border border-dashed border-divider p-6 text-center">
            <div
              className="mx-auto flex size-12 items-center justify-center rounded-full bg-default-100 text-default-500"
              aria-hidden="true"
            >
              <ShieldCheck className="size-6" />
            </div>
            <p className="mt-3 font-medium text-foreground">暂无登录会话记录</p>
            <p className="mt-1 text-default-500">
              刷新后仍为空时，请重新登录以创建当前设备会话。
            </p>
            <Button
              className="mt-4"
              variant="flat"
              startContent={<RefreshCw className="size-4" />}
              onPress={refreshSessions}
            >
              刷新
            </Button>
          </div>
        )}
      </CardBody>

      <Divider />

      <CardFooter className="items-start gap-2 border-t border-default-100 bg-default-50/60 px-5 py-4 text-default-500 dark:bg-default-100/10">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="leading-6">
          撤销会话会让对应设备的下次请求失效。当前设备退出登录请使用顶部栏退出入口。
        </p>
      </CardFooter>

      <Modal isOpen={isOpen} onClose={closeRevokeModal} placement="center">
        <ModalContent>
          <ModalHeader className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-danger" />
            {confirmMode === 'others' ? '撤销其它登录会话' : '撤销登录会话'}
          </ModalHeader>
          <ModalBody>
            {confirmMode === 'others' ? (
              <div className="rounded-large border border-danger/20 bg-danger/5 p-4">
                <p className="font-medium text-foreground">
                  将撤销 {otherSessionCount} 个其它设备的登录状态。
                </p>
                <p className="mt-2 leading-6 text-default-500">
                  当前设备会保留登录。被撤销的设备需要重新输入账号密码。
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="leading-6 text-default-600">
                  撤销后，该设备会在下次请求时失效并需要重新登录。
                </p>
                {selectedSession && selectedDevice && (
                  <div className="rounded-large border border-danger/20 bg-danger/5 p-4">
                    <p className="font-medium text-foreground">
                      {selectedDevice.label}
                    </p>
                    <p className="mt-1 break-all text-default-500">
                      {getUserAgentPreview(selectedSession.userAgent)}
                    </p>
                    <p className="mt-2 text-default-500">
                      IP: {selectedSession.ip || '未知 IP'}
                    </p>
                  </div>
                )}
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="light"
              onPress={closeRevokeModal}
              isDisabled={isRevoking}
            >
              取消
            </Button>
            <Button
              color="danger"
              isLoading={isRevoking}
              onPress={handleConfirmRevoke}
            >
              {confirmMode === 'others' ? '撤销其它会话' : '确认撤销'}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Card>
  )
}
