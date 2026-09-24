import { CardContainer } from '~/components/galgame/Container'
import { kunMetadata } from './metadata'
import { Suspense } from 'react'
import { kunGetActions } from './actions'
import { ErrorComponent } from '~/components/error/ErrorComponent'
import { getCurrentSiteYear } from '~/utils/time'
import type { Metadata } from 'next'

export const metadata: Metadata = kunMetadata

export default async function Kun() {
  const response = await kunGetActions({
    selectedType: 'all',
    selectedLanguage: 'all',
    selectedPlatform: 'all',
    sortField: 'resource_update_time',
    sortOrder: 'desc',
    page: 1,
    limit: 24,
    yearString: JSON.stringify(['all']),
    monthString: JSON.stringify(['all']),
    minRatingCount: 0
  })
  if (typeof response === 'string') {
    return <ErrorComponent error={response} />
  }

  // 页面级 Suspense 在流式 SSR 中总被外置 (S:1), 由内联 $RC 脚本稍后揭示; shell 若先于
  // 揭示绘制, 列表出现时会把页脚推下去 (移动 CLS 0.1374). 仅在占位 <template> 尚在时
  // 预留整屏高度让页脚落在视口外, 揭示后占位被移除, 规则随之失效
  return (
    <div className="w-full has-[>template]:min-h-dvh">
      <Suspense>
        <CardContainer
          initialGalgames={response.galgames}
          initialTotal={response.total}
          filterEndYear={getCurrentSiteYear()}
        />
      </Suspense>
    </div>
  )
}
