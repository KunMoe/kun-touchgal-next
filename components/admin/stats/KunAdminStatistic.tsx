'use client'

import { FC, useState } from 'react'
import { Divider, Slider } from '@heroui/react'
import { useDebounce } from 'use-debounce'
import { KunAdminSum } from './KunAdminSum'
import { kunFetchGet } from '~/utils/kunFetch'
import { StatsCard } from './StatsCard'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { useKunKeyedQuery } from '~/hooks/useKunKeyedQuery'
import { ADMIN_STATS_MAP } from '~/constants/admin'
import type { OverviewData } from '~/types/api/admin'

export const KunAdminStatistic: FC = () => {
  const [days, setDays] = useState(1)
  const [debouncedDays] = useDebounce(days, 300)
  // 只让当前天数的应答落地; 失败时保留上一份数字和它所属的天数 (P23-02)
  const overview = useKunKeyedQuery({
    key: debouncedDays,
    fetch: (days) =>
      kunFetchGet<KunResponse<OverviewData>>('/admin/stats', { days }),
    onFailure: (message) => kunErrorHandler(message, () => {})
  })
  // 骨架只在第一份数据落地之前显示; 第一次就失败时显示 0
  const loading = !overview.data && overview.status === 'loading'

  return (
    <div className="space-y-8">
      <KunAdminSum />

      <Divider />

      <div className="flex flex-col space-y-6">
        {/* 标题写屏幕上这份数字所属的天数, 不写滑块的当前值 */}
        <h3 className="text-lg font-semibold whitespace-nowrap">{`${overview.dataKey ?? days} 天内数据统计`}</h3>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {Object.entries(ADMIN_STATS_MAP).map(([key, title]) => (
            <StatsCard
              key={key}
              title={title}
              value={overview.data?.[key as keyof OverviewData] ?? 0}
              isLoading={loading}
            />
          ))}
        </div>

        <div className="flex-grow max-w-xl">
          <Slider
            label="设置天数"
            step={1}
            minValue={1}
            maxValue={60}
            value={days}
            getValue={(value) => `${value} 天`}
            onChange={(value) => setDays(Number(value))}
          />
        </div>
      </div>
    </div>
  )
}
