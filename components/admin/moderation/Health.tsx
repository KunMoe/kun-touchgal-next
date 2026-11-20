'use client'

import { Chip } from '@heroui/react'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import {
  MODERATION_LANE,
  MODERATION_LANE_MAP,
  MODERATION_LANE_REASON_MAP,
  formatModerationFailureKind
} from '~/constants/moderation'
import type { AdminModerationStats } from '~/types/api/admin'

type LaneState = NonNullable<
  AdminModerationStats['worker']
>['lanes']['text']['state']

// 影子模式下车道只观察不拦截: 显示为「打开」时任务仍在照常处理, 文案要分开
const stateLabel: Record<'shadow' | 'enforce', Record<LaneState, string>> = {
  enforce: { closed: '正常', open: '已暂停', half_open: '探测中' },
  shadow: { closed: '正常', open: '疑似故障', half_open: '疑似故障, 探测中' }
}

const stateColor = {
  closed: 'success',
  open: 'danger',
  half_open: 'warning'
} as const

const formatClock = (time: number) =>
  new Date(time).toLocaleTimeString('zh-CN', { hour12: false })

interface Props {
  stats: AdminModerationStats
}

// 审核队列有没有在动: worker 上报的车道状态、最早一条待审核任务等了多久、
// 转人工的任务各是什么原因
export const ModerationHealth = ({ stats }: Props) => {
  const { worker, oldestPendingAt } = stats
  const manualKinds = [
    ...Object.entries(stats.manualKindCounts).map(
      ([kind, count]) => [formatModerationFailureKind(kind), count] as const
    ),
    ['AI 拿不准', stats.manualUnsureCount] as const,
    ['未分类 (旧任务)', stats.manualUnclassifiedCount] as const
  ].filter(([, count]) => count > 0)

  return (
    <div className="space-y-2 border-t border-default-200 pt-3">
      {worker ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-default-500">审核车道</span>
            {MODERATION_LANE.map((lane) => {
              const { state, reason } = worker.lanes[lane]
              return (
                <Chip
                  key={lane}
                  color={stateColor[state]}
                  variant="flat"
                  size="sm"
                >
                  {MODERATION_LANE_MAP[lane]}: {stateLabel[worker.mode][state]}
                  {reason
                    ? ` · ${MODERATION_LANE_REASON_MAP[reason] ?? reason}`
                    : ''}
                </Chip>
              )
            })}
            <span className="text-xs text-default-500">
              上报于 <KunTimeAgo date={worker.at} />
              {worker.mode === 'shadow'
                ? ' · 影子模式: 只观察不拦截, 失败仍逐条重试'
                : ''}
            </span>
          </div>
          {MODERATION_LANE.map((lane) => {
            const { state, since, openUntil, lastError } = worker.lanes[lane]
            if (state === 'closed') {
              return null
            }
            return (
              <p key={lane} className="break-all text-sm text-default-600">
                {MODERATION_LANE_MAP[lane]}车道
                {since !== null && (
                  <>
                    {' '}
                    自 <KunTimeAgo date={since} /> 起异常
                  </>
                )}
                {worker.mode === 'enforce' &&
                state === 'open' &&
                openUntil !== null
                  ? `, ${formatClock(openUntil)} 后放一条任务探测`
                  : ''}
                {lastError ? `, 最近一次错误: ${lastError}` : ''}
              </p>
            )
          })}
        </>
      ) : (
        <p className="text-sm text-warning-600">
          审核 worker 最近两分钟没有上报状态: 刚发布完的几分钟内属正常,
          一直如此则定时任务进程可能没有在运行
        </p>
      )}

      {oldestPendingAt && (
        <p className="text-sm text-default-600">
          最早一条待审核任务提交于 <KunTimeAgo date={oldestPendingAt} />
        </p>
      )}

      {manualKinds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-default-500">转人工的原因</span>
          {manualKinds.map(([label, count]) => (
            <Chip key={label} variant="flat" size="sm">
              {label} {count}
            </Chip>
          ))}
        </div>
      )}
    </div>
  )
}
