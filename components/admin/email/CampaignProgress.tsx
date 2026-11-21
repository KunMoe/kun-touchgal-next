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
import {
  MAIL_CAMPAIGN_BATCH_SIZE,
  MAIL_CAMPAIGN_STATUS_MAP
} from '~/constants/admin'
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

type CampaignAction = 'cancel' | 'resume'

// 还没有结束的任务: 可以取消; 暂停的还可以继续
const isActive = (campaign: AdminMailCampaign) =>
  campaign.status === 'sending' || campaign.status === 'paused'

interface Props {
  // 提交过一次建任务的请求之后由父组件加一, 让这里立刻重读一次
  refreshKey: number
}

// 最近的群发任务与进度。打开页面就能看到有没有任务在发、发到了哪里, 不必靠「再发一次」
// 来确认
export const CampaignProgress = ({ refreshKey }: Props) => {
  const [campaigns, setCampaigns] = useState<AdminMailCampaign[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [pending, setPending] = useState<{
    id: number
    action: CampaignAction
  } | null>(null)
  const [cancelTargetId, setCancelTargetId] = useState<number | null>(null)
  const { isOpen, onOpen, onClose } = useDisclosure()
  const requestSeqRef = useRef(0)
  const appliedSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    const res = await kunFetchGet<AdminMailCampaign[]>('/admin/mail')
    // 轮询与操作之后的重读可能交错返回: 比已经采用的那一次更早发出的丢掉。不能只认
    // 「最后发出的那一次」: 应答比轮询间隔还慢时, 每一次都会在返回之前被下一次顶掉,
    // 列表就再也不更新了
    if (seq < appliedSeqRef.current) {
      return
    }
    appliedSeqRef.current = seq
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

  // 只有本站会推进的任务才值得轮询; 随数据库副本带过来的任务在这里不会动
  const hasSending =
    campaigns?.some(
      (campaign) => campaign.status === 'sending' && campaign.runsHere
    ) ?? false
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

  // 确认框问的那个任务已经结束 (发完了, 或被别处取消了) 就不再开着
  const cancelTargetActive =
    campaigns?.some(
      (campaign) => campaign.id === cancelTargetId && isActive(campaign)
    ) ?? false

  const transition = async (campaignId: number, action: CampaignAction) => {
    setPending({ id: campaignId, action })
    const res = await kunFetchPut<KunResponse<{}>>('/admin/mail', {
      campaignId,
      action
    })
    // 成功与否都重读, 读完才放开按钮: 被拒绝多半是任务的状态已经变了, 按钮不该在旧状态上
    // 重新可点
    await load()
    setPending(null)
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
            {
              '邮件由后台的定时任务分批发出, 关闭本页面不影响发送。上一个任务发完或取消之前不能发起新的'
            }
          </p>
        </div>

        {loadError && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-danger">
              读取任务失败: {loadError}
            </p>
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
              // 预计人数是创建时估的, 发送期间有人退订, 发完时可以比它少: 发完的一律画满
              const barMax = Math.max(
                campaign.status === 'done' ? processed : campaign.total,
                processed,
                1
              )
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
                    <span className="sr-only">群发任务 #{campaign.id}</span>
                    <Chip
                      color={statusColor[campaign.status] ?? 'default'}
                      variant="flat"
                      size="sm"
                    >
                      {MAIL_CAMPAIGN_STATUS_MAP[campaign.status] ??
                        campaign.status}
                    </Chip>
                    {campaign.status === 'paused' && (
                      <>
                        {campaign.lastError && (
                          <p className="text-sm break-all text-warning-600">
                            {campaign.lastError}
                          </p>
                        )}
                        <p className="text-sm text-default-500">
                          {
                            '确认邮件服务恢复之后再继续发送。继续时刚才这一批会整批重发, 其中已经收到的人会再收到一封'
                          }
                        </p>
                      </>
                    )}
                    {isActive(campaign) && !campaign.runsHere && (
                      <p className="text-sm break-all text-warning-600">
                        {`这个任务是在 ${campaign.siteOrigin} 上发起的, 随数据库的副本来到这里, 本站不会推进它。不需要的话直接取消`}
                      </p>
                    )}
                  </div>

                  <Progress
                    aria-label={`群发任务 #${campaign.id} 的发送进度`}
                    size="sm"
                    color={statusColor[campaign.status] ?? 'default'}
                    value={campaign.status === 'done' ? barMax : processed}
                    maxValue={barMax}
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

                  {isActive(campaign) && (
                    <div className="flex gap-2">
                      {campaign.status === 'paused' && (
                        <Button
                          size="sm"
                          color="primary"
                          variant="flat"
                          isDisabled={pending !== null}
                          isLoading={
                            pending?.id === campaign.id &&
                            pending.action === 'resume'
                          }
                          onPress={() => transition(campaign.id, 'resume')}
                        >
                          继续发送
                        </Button>
                      )}
                      <Button
                        size="sm"
                        color="danger"
                        variant="flat"
                        isDisabled={pending !== null}
                        onPress={() => {
                          setCancelTargetId(campaign.id)
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

      <Modal isOpen={isOpen && cancelTargetActive} onClose={onClose}>
        <ModalContent>
          <ModalHeader>确定要取消群发任务 #{cancelTargetId} 吗?</ModalHeader>
          <ModalBody>
            <p>
              {`已经发出的邮件无法撤回, 正在发出的这一批 (至多 ${MAIL_CAMPAIGN_BATCH_SIZE} 封) 仍会送达。取消之后这个任务不能再继续, 其余还没有收到的用户不会再收到这封邮件; 重新发起则会从头发给全体用户。`}
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onClose}>
              先不取消
            </Button>
            <Button
              color="danger"
              isDisabled={pending !== null}
              isLoading={pending?.action === 'cancel'}
              onPress={() => {
                if (cancelTargetId !== null) {
                  void transition(cancelTargetId, 'cancel')
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
