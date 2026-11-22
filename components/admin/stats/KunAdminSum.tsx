'use client'

import { FC } from 'react'
import { StatsCard } from './StatsCard'
import { kunFetchGet } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { useKunKeyedQuery } from '~/hooks/useKunKeyedQuery'
import { ADMIN_STATS_SUM_MAP } from '~/constants/admin'
import type { SumData } from '~/types/api/admin'

export const KunAdminSum: FC = () => {
  // 常量键: 挂载时取一次。失败时显示 0
  const sum = useKunKeyedQuery({
    key: 'sum',
    fetch: () => kunFetchGet<KunResponse<SumData>>('/admin/stats/sum'),
    onFailure: (message) => kunErrorHandler(message, () => {})
  })
  const loading = sum.status === 'loading'

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">数据统计</h2>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Object.entries(ADMIN_STATS_SUM_MAP).map(([key, title]) => (
          <StatsCard
            key={key}
            title={title}
            value={sum.data?.[key as keyof SumData] ?? 0}
            isLoading={loading}
          />
        ))}
      </div>
    </div>
  )
}
