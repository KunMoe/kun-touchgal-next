'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Progress,
  useDisclosure
} from '@heroui/react'
import toast from 'react-hot-toast'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { MAIL_CAMPAIGN_STATUS_MAP } from '~/constants/admin'
import {
  CAMPAIGN_TEMPLATES,
  isCampaignTemplateId
} from '~/constants/email/campaign'
import { DELETED_USER_NAME } from '~/constants/user'
import { kunFetchGet, kunFetchPut } from '~/utils/kunFetch'
import type { AdminMailCampaign } from '~/types/api/admin'

// 有任务在发送时多久读一次进度。发信在定时任务进程里每分钟推进一拍, 这里只是读任务行
const POLL_INTERVAL_MS = 5000

const statusColor: Record<
  string,
  'primary' | 'warning' | 'success' | 'default'
> = {
  sending: 'primary',
  paused: 'warning',
  done: 'success',
  cancelled: 'default'
}

interface Props {
  // 新建任务之后由父组件加一, 让这里立刻重读一次
  refreshKey: number
}

// 最近的群发任务与进度。打开页面就能看到有没有任务在发、发到了哪里, 不必靠「再发一次」
// 来确认
export const CampaignProgress = ({ refreshKey }: Props) => {
  const [campaigns, setCampaigns] = useState<AdminMailCampaign[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [cancelTarget, setCancelTarget] = useState<AdminMailCampaign | null>(
    null
  )
  const { isOpen, onOpen, onClose } = useDisclosure()
  const latestRequestIdRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++latestRequestIdRef.current
    const res = await kunFetchGet<AdminMailCampaign[]>('/admin/mail')
    // 只认最后发出的那一次: 轮询与操作之后的重读可能交错返回
    if (requestId !== latestRequestIdRef.current) {
      return
    }
    if (typeof res === 'string') {
      setLoadError(res)
      return
    }
    setLoadError('')
    setCampaigns(res)
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const hasSending =
    campaigns?.some((campaign) => campaign.status === 'sending') ?? false
  useEffect(() => {
    if (!hasSending) {
      return
    }
    const timer = setInterval(() => {
      // 页面在后台时不读, 切回来最迟一个间隔后跟上
      if (!document.hidden) {
        void load()
      }
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [hasSending, load])

  const transition = async (
    campaignId: number,
    action: 'cancel' | 'resume'
  ) => {
    setPendingId(campaignId)
    const res = await kunFetchPut<KunResponse<{}>>('/admin/mail', {
      campaignId,
      action
    })
    setPendingId(null)
    // 成功与否都重读: 被拒绝多半是任务的状态已经变了
    void load()
    if (typeof res === 'string') {
      toast.error(res)
      return
    }
    toast.success(
      action === 'cancel'
        ? `群发任务 #${campaignId} 已取消`
        : `群发任务 #${campaignId} 将在一分钟内继续发送`
    )
    onClose()
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">群发任务</h3>
          <p className="text-small text-default-500">
            邮件由后台的定时任务分批发出,
            关闭本页面不影响发送。同一时间只能有一个 进行中的任务
          </p>
        </div>

        {loadError && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-danger">读取任务失败: {loadError}</p>
            <Button size="sm" variant="flat" onPress={() => void load()}>
              重试
            </Button>
          </div>
        )}

        {campaigns === null && !loadError && (
          <p className="text-sm text-default-500">正在读取任务...</p>
        )}

        {campaigns?.length === 0 && (
          <p className="text-sm text-default-500">还没有发起过群发任务</p>
        )}

        {campaigns && campaigns.length > 0 && (
          <ul className="divide-y divide-default-200">
            {campaigns.map((campaign) => {
              const processed = campaign.sent + campaign.failed
              const isActive =
                campaign.status === 'sending' || campaign.status === 'paused'
              return (
                <li
                  key={campaign.id}
                  className="space-y-2 py-4 first:pt-0 last:pb-0"
                >
                  <p className="font-medium break-all">
                    #{campaign.id} {campaign.title}
                  </p>

                  {/* 状态变了才需要读出来; 每次轮询都在变的数字放在这个区域之外 */}
                  <div role="status" className="space-y-1">
                    <Chip
                      color={statusColor[campaign.status] ?? 'default'}
                      variant="flat"
                      size="sm"
                    >
                      {MAIL_CAMPAIGN_STATUS_MAP[campaign.status] ??
                        campaign.status}
                    </Chip>
                    {campaign.status === 'paused' && campaign.lastError && (
                      <p className="text-sm break-all text-warning-600">
                        {campaign.lastError}
                      </p>
                    )}
                  </div>

                  <Progress
                    aria-label={`群发任务 #${campaign.id} 的发送进度`}
                    size="sm"
                    color={campaign.status === 'done' ? 'success' : 'primary'}
                    value={processed}
                    // 预计人数是创建时估的, 期间有人退订, 发完时可以比它少
                    maxValue={
                      campaign.status === 'done'
                        ? Math.max(processed, 1)
                        : Math.max(campaign.total, processed, 1)
                    }
                  />

                  <p className="text-sm text-default-600">
                    成功 {campaign.sent} 封, 失败 {campaign.failed} 封, 预计共{' '}
                    {campaign.total} 封
                  </p>
                  <p className="text-sm text-default-500">
                    {isCampaignTemplateId(campaign.templateId)
                      ? CAMPAIGN_TEMPLATES[campaign.templateId].name
                      : campaign.templateId}
                    {' · '}
                    {campaign.creator?.name ?? DELETED_USER_NAME} 发起于{' '}
                    <KunTimeAgo date={campaign.created} />
                    {campaign.finished && (
                      <>
                        {' · 结束于 '}
                        <KunTimeAgo date={campaign.finished} />
                      </>
                    )}
                  </p>

                  {isActive && (
                    <div className="flex gap-2">
                      {campaign.status === 'paused' && (
                        <Button
                          size="sm"
                          color="primary"
                          variant="flat"
                          isDisabled={pendingId !== null}
                          isLoading={pendingId === campaign.id && !isOpen}
                          onPress={() => transition(campaign.id, 'resume')}
                        >
                          继续发送
                        </Button>
                      )}
                      <Button
                        size="sm"
                        color="danger"
                        variant="flat"
                        isDisabled={pendingId !== null}
                        onPress={() => {
                          setCancelTarget(campaign)
                          onOpen()
                        }}
                      >
                        取消任务
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardBody>

      <Modal isOpen={isOpen} onClose={onClose}>
        <ModalContent>
          <ModalHeader>确定要取消群发任务 #{cancelTarget?.id} 吗?</ModalHeader>
          <ModalBody>
            <p>
              已经发出的邮件无法撤回。取消之后这个任务不能再继续,
              还没有收到的用户不会再收到这封邮件; 重新发起则会从头发给全体用户。
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onClose}>
              先不取消
            </Button>
            <Button
              color="danger"
              isDisabled={pendingId !== null}
              isLoading={pendingId !== null}
              onPress={() => {
                if (cancelTarget) {
                  void transition(cancelTarget.id, 'cancel')
                }
              }}
            >
              取消任务
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Card>
  )
}
