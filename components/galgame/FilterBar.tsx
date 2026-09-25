'use client'

import { memo, startTransition, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger
} from '@heroui/dropdown'
import { Button } from '@heroui/button'
import { Card, CardHeader, CardBody } from '@heroui/card'
import { Divider } from '@heroui/divider'
import { Skeleton } from '@heroui/skeleton'
import { ArrowDownAZ, ArrowUpAZ, ChevronDown, ChevronUp } from 'lucide-react'
import { DEFAULT_GALGAME_MIN_RATING_COUNT } from '~/utils/galgameFilter'
import type { AdvancedFilterPanelProps } from './AdvancedFilterPanel'
import type { SortField, SortOrder } from './_sort'

// 高级筛选面板默认收起, 却连带 Select / Listbox / 虚拟列表约 22KB gz 进入
// /galgame、/search、/tag/[id]、/company/[id] 首屏. 改为按需加载, 悬停与聚焦时预热
const loadAdvancedFilterPanel = () => import('./AdvancedFilterPanel')

const AdvancedFilterPanel = dynamic(
  () => loadAdvancedFilterPanel().then((mod) => mod.AdvancedFilterPanel),
  { loading: () => <AdvancedFilterPanelFallback /> }
)

const preloadAdvancedFilterPanel = () => {
  void loadAdvancedFilterPanel()
}

// 与面板同高 (两行 48px 控件), 块未到时先占位, 避免到达后再把卡片列表推下去
const AdvancedFilterPanelFallback = () => (
  <>
    <Divider />
    <CardBody className="pt-3">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-12 rounded-large" />
          <Skeleton className="h-12 rounded-large" />
          <Skeleton className="h-12 rounded-large" />
        </div>
        <div className="flex flex-wrap sm:flex-nowrap gap-3">
          <Skeleton className="h-12 w-full rounded-large" />
          <Skeleton className="h-12 w-full rounded-large" />
          <Skeleton className="h-12 w-full rounded-large" />
          <Skeleton className="h-12 w-24 shrink-0 rounded-large ml-auto" />
        </div>
      </div>
    </CardBody>
  </>
)

interface Props extends Omit<
  AdvancedFilterPanelProps,
  'defaultMinRatingCount'
> {
  setSortField: (option: SortField) => void
  sortOrder: SortOrder
  setSortOrder: (direction: SortOrder) => void
  defaultMinRatingCount?: number
}

const sortFieldLabelMap: Record<string, string> = {
  resource_update_time: '资源更新时间',
  created: '游戏创建时间',
  rating: '评分',
  view: '浏览量',
  download: '下载量',
  favorite: '收藏量'
}

export const FilterBar = memo(function FilterBar({
  selectedType,
  setSelectedType,
  sortField,
  setSortField,
  sortOrder,
  setSortOrder,
  selectedLanguage,
  setSelectedLanguage,
  selectedPlatform,
  setSelectedPlatform,
  selectedYears,
  setSelectedYears,
  selectedMonths,
  setSelectedMonths,
  minRatingCount,
  setMinRatingCount,
  defaultMinRatingCount = DEFAULT_GALGAME_MIN_RATING_COUNT,
  endYear
}: Props) {
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const currentSortLabel =
    sortFieldLabelMap[sortField] ?? (sortField === 'rating' ? '评分' : '排序')

  const ratingFilterActive =
    sortField === 'rating' && minRatingCount !== defaultMinRatingCount

  const hasActiveFilters =
    selectedType !== 'all' ||
    selectedLanguage !== 'all' ||
    selectedPlatform !== 'all' ||
    !selectedYears.includes('all') ||
    !selectedMonths.includes('all') ||
    ratingFilterActive

  const toggleAdvancedFilters = () => {
    // 在 transition 里挂载懒加载面板: 块已预热时 React 会等 import() 在微任务里
    // 完成而不先提交 fallback, 从而绕开 Suspense 揭示的 300ms 节流
    startTransition(() => {
      setShowAdvancedFilters((current) => !current)
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex justify-between gap-3 w-full">
          <div className="flex gap-3">
            <Dropdown>
              <DropdownTrigger>
                <Button
                  variant="flat"
                  className="w-full justify-between text-sm"
                  endContent={<ChevronDown className="size-4" />}
                >
                  {currentSortLabel}
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label="排序选项"
                selectedKeys={new Set([sortField])}
                onAction={(key) => setSortField(key as SortField)}
                selectionMode="single"
                className="min-w-[200px]"
              >
                <DropdownItem
                  key="resource_update_time"
                  className="text-default-700"
                >
                  资源更新时间
                </DropdownItem>
                <DropdownItem key="created" className="text-default-700">
                  游戏创建时间
                </DropdownItem>
                <DropdownItem key="rating" className="text-default-700">
                  评分
                </DropdownItem>
                <DropdownItem key="view" className="text-default-700">
                  浏览量
                </DropdownItem>
                <DropdownItem key="download" className="text-default-700">
                  下载量
                </DropdownItem>
                <DropdownItem key="favorite" className="text-default-700">
                  收藏量
                </DropdownItem>
              </DropdownMenu>
            </Dropdown>

            <Button
              variant="flat"
              className="text-sm shrink-0"
              onPress={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
              startContent={
                sortOrder === 'asc' ? (
                  <ArrowUpAZ className="size-4" />
                ) : (
                  <ArrowDownAZ className="size-4" />
                )
              }
            >
              <span className="sm:hidden">
                {sortOrder === 'asc' ? '升序' : '降序'}
              </span>
              <span className="hidden sm:inline">
                {sortOrder === 'asc' ? '升序' : '降序'}
              </span>
            </Button>
          </div>

          <Button
            variant={showAdvancedFilters ? 'solid' : 'flat'}
            className="sm:w-auto text-sm"
            onPress={toggleAdvancedFilters}
            onPointerEnter={preloadAdvancedFilterPanel}
            onFocus={preloadAdvancedFilterPanel}
            endContent={
              showAdvancedFilters ? (
                <ChevronUp className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )
            }
            color={hasActiveFilters ? 'primary' : 'default'}
          >
            高级筛选
          </Button>
        </div>
      </CardHeader>

      {showAdvancedFilters && (
        <AdvancedFilterPanel
          selectedType={selectedType}
          setSelectedType={setSelectedType}
          sortField={sortField}
          selectedLanguage={selectedLanguage}
          setSelectedLanguage={setSelectedLanguage}
          selectedPlatform={selectedPlatform}
          setSelectedPlatform={setSelectedPlatform}
          selectedYears={selectedYears}
          setSelectedYears={setSelectedYears}
          selectedMonths={selectedMonths}
          setSelectedMonths={setSelectedMonths}
          minRatingCount={minRatingCount}
          setMinRatingCount={setMinRatingCount}
          defaultMinRatingCount={defaultMinRatingCount}
          endYear={endYear}
        />
      )}
    </Card>
  )
})
