'use client'

import { useMemo } from 'react'
import { Button } from '@heroui/button'
import { CardBody } from '@heroui/card'
import { Select, SelectItem } from '@heroui/select'
import { Input } from '@heroui/react'
import { Divider } from '@heroui/divider'
import { Calendar, Filter } from 'lucide-react'
import {
  ALL_SUPPORTED_LANGUAGE,
  ALL_SUPPORTED_PLATFORM,
  ALL_SUPPORTED_TYPE,
  SUPPORTED_LANGUAGE_MAP,
  SUPPORTED_PLATFORM_MAP,
  SUPPORTED_TYPE_MAP
} from '~/constants/resource'
import type { SortField } from './_sort'

export interface AdvancedFilterPanelProps {
  selectedType: string
  setSelectedType: (types: string) => void
  sortField: SortField
  selectedLanguage: string
  setSelectedLanguage: (language: string) => void
  selectedPlatform: string
  setSelectedPlatform: (platform: string) => void
  selectedYears: string[]
  setSelectedYears: (years: string[]) => void
  selectedMonths: string[]
  setSelectedMonths: (months: string[]) => void
  minRatingCount?: number
  setMinRatingCount?: (count: number) => void
  defaultMinRatingCount: number
  endYear: number
}

const getGalgameSortYears = (endYear: number) => [
  'all',
  'future',
  'unknown',
  ...Array.from({ length: endYear - 1979 }, (_, i) => String(endYear - i))
]

const GALGAME_SORT_YEARS_MAP: Record<string, string> = {
  all: '全部年份',
  future: '未发售',
  unknown: '未知年份'
}

const GALGAME_SORT_MONTHS = [
  'all',
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  '12'
]

export const AdvancedFilterPanel = ({
  selectedType,
  setSelectedType,
  sortField,
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
  defaultMinRatingCount,
  endYear
}: AdvancedFilterPanelProps) => {
  const yearOptions = useMemo(() => getGalgameSortYears(endYear), [endYear])

  return (
    <>
      <Divider />
      <CardBody className="pt-3">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Select
              label="类型筛选"
              placeholder="选择类型"
              selectedKeys={[selectedType]}
              onChange={(event) => {
                if (!event.target.value) {
                  return
                }
                setSelectedType(event.target.value)
              }}
              startContent={<Filter className="size-4 text-default-400" />}
              radius="lg"
              size="sm"
            >
              {ALL_SUPPORTED_TYPE.map((type) => (
                <SelectItem key={type} className="text-default-700">
                  {SUPPORTED_TYPE_MAP[type]}
                </SelectItem>
              ))}
            </Select>

            <Select
              label="语言筛选"
              placeholder="选择语言"
              selectedKeys={[selectedLanguage]}
              onChange={(event) => {
                if (!event.target.value) {
                  return
                }
                setSelectedLanguage(event.target.value)
              }}
              startContent={<Filter className="size-4 text-default-400" />}
              radius="lg"
              size="sm"
            >
              {ALL_SUPPORTED_LANGUAGE.map((language) => (
                <SelectItem key={language} className="text-default-700">
                  {SUPPORTED_LANGUAGE_MAP[language]}
                </SelectItem>
              ))}
            </Select>

            <Select
              label="平台筛选"
              placeholder="选择平台"
              selectedKeys={[selectedPlatform]}
              onChange={(event) => {
                if (!event.target.value) {
                  return
                }
                setSelectedPlatform(event.target.value)
              }}
              startContent={<Filter className="size-4 text-default-400" />}
              radius="lg"
              size="sm"
            >
              {ALL_SUPPORTED_PLATFORM.map((platform) => (
                <SelectItem key={platform} className="text-default-700">
                  {SUPPORTED_PLATFORM_MAP[platform]}
                </SelectItem>
              ))}
            </Select>
          </div>

          <div className="flex flex-wrap sm:flex-nowrap gap-3">
            <Select
              disallowEmptySelection
              label="发售年份"
              placeholder="选择年份"
              selectedKeys={selectedYears}
              disabledKeys={['future']}
              onSelectionChange={(keys) => {
                if (keys.anchorKey === 'all') {
                  setSelectedYears(['all'])
                  setSelectedMonths(['all'])
                } else {
                  setSelectedYears(
                    Array.from(keys as Set<string>).filter(
                      (item) => item !== 'all'
                    )
                  )
                }
              }}
              startContent={<Calendar className="size-4 text-default-400" />}
              selectionMode="multiple"
              radius="lg"
              size="sm"
            >
              {yearOptions.map((year) => (
                <SelectItem key={year} className="text-default-700">
                  {GALGAME_SORT_YEARS_MAP[year] ?? year}
                </SelectItem>
              ))}
            </Select>

            <Select
              disallowEmptySelection
              label="发售月份"
              placeholder="选择月份"
              selectedKeys={selectedMonths}
              onSelectionChange={(keys) => {
                if (keys.anchorKey === 'all') {
                  setSelectedMonths(['all'])
                } else {
                  setSelectedMonths(
                    Array.from(keys as Set<string>).filter(
                      (item) => item !== 'all'
                    )
                  )
                }
              }}
              startContent={<Calendar className="size-4 text-default-400" />}
              selectionMode="multiple"
              radius="lg"
              size="sm"
              isDisabled={
                selectedYears.includes('all') ||
                selectedYears.includes('future')
              }
            >
              {GALGAME_SORT_MONTHS.map((month) => (
                <SelectItem key={month} className="text-default-700">
                  {month === 'all' ? '全部月份' : month}
                </SelectItem>
              ))}
            </Select>

            {setMinRatingCount && (
              <Input
                type="number"
                label="最低评分人数（仅评分排序生效）"
                placeholder={String(defaultMinRatingCount)}
                size="sm"
                value={String(minRatingCount)}
                min={0}
                onValueChange={(value) => {
                  const parsed = Number(value)
                  if (Number.isNaN(parsed)) {
                    return
                  }
                  setMinRatingCount(Math.max(0, parsed))
                }}
                isDisabled={sortField !== 'rating'}
              />
            )}

            <Button
              radius="lg"
              size="lg"
              variant="flat"
              className="text-sm ml-auto"
              onPress={() => {
                setSelectedType('all')
                setSelectedLanguage('all')
                setSelectedPlatform('all')
                setSelectedYears(['all'])
                setSelectedMonths(['all'])
                setMinRatingCount?.(defaultMinRatingCount)
              }}
            >
              重置筛选
            </Button>
          </div>
        </div>
      </CardBody>
    </>
  )
}
