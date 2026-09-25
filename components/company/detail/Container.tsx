'use client'

import { useEffect, useRef, useState } from 'react'
import { useDebounce } from 'use-debounce'
import dynamic from 'next/dynamic'
import { useRouter } from '@bprogress/next/app'
import { useSearchParams } from 'next/navigation'
import { Button, Chip } from '@heroui/react'
import { useDisclosure } from '@heroui/modal'
import { Link } from '@heroui/link'
import { Pencil } from 'lucide-react'
import { useMounted } from '~/hooks/useMounted'
import { KunHeader } from '~/components/kun/Header'
import { KunUser } from '~/components/kun/floating-card/KunUser'
import { KunLoading } from '~/components/kun/Loading'
import { GalgameCard } from '~/components/galgame/Card'
import { KunNull } from '~/components/kun/Null'
import { KunPagination } from '~/components/kun/Pagination'
import { LazyDialogFallback } from '~/components/patch/header/LazyDialogFallback'
import { DeleteCompanyModal } from './DeleteCompanyModal'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { kunFetchGet } from '~/utils/kunFetch'
import { SUPPORTED_LANGUAGE_MAP } from '~/constants/resource'
import { useUserStore } from '~/store/userStore'
import { FilterBar } from '~/components/galgame/FilterBar'
import type { CompanyDetail } from '~/types/api/company'
import type { SortField, SortOrder } from '~/components/galgame/_sort'
import type { FC } from 'react'
import {
  DEFAULT_GALGAME_FILTER_VALUE,
  DEFAULT_GALGAME_SORT_FIELD,
  DEFAULT_GALGAME_SORT_ORDER,
  DEFAULT_TAG_COMPANY_MIN_RATING_COUNT,
  kunShouldResetOverflowPage,
  parseGalgameFilterArray,
  toNumberParam
} from '~/utils/galgameFilter'
import { errorReporter, kunErrorHandler } from '~/utils/kunErrorHandler'

// 表单连带 zod 全量 / RHF, 只有管理员用得到, 静态导入会让每位访客首屏
// 多下约 110KB gz. 首次打开后保持挂载, 保留关闭动画
const CompanyFormModal = dynamic(
  () => import('../form/CompanyFormModal').then((m) => m.CompanyFormModal),
  { ssr: false, loading: () => <LazyDialogFallback hint="正在加载编辑器..." /> }
)

const preloadCompanyFormModal = () => {
  void import('../form/CompanyFormModal')
}

interface Props {
  initialCompany: CompanyDetail
  initialPatches: GalgameCard[]
  total: number
  filterEndYear: number
}

export const CompanyDetailContainer: FC<Props> = ({
  initialCompany,
  initialPatches,
  total,
  filterEndYear
}) => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [hasOpenedEdit, setHasOpenedEdit] = useState(false)

  const isMounted = useMounted()
  const user = useUserStore((state) => state.user)
  const router = useRouter()
  const searchParams = useSearchParams()
  const [page, setPage] = useState(toNumberParam(searchParams.get('page'), 1))
  const [selectedType, setSelectedType] = useState(
    searchParams.get('selectedType') || DEFAULT_GALGAME_FILTER_VALUE
  )
  const [selectedLanguage, setSelectedLanguage] = useState(
    searchParams.get('selectedLanguage') || DEFAULT_GALGAME_FILTER_VALUE
  )
  const [selectedPlatform, setSelectedPlatform] = useState(
    searchParams.get('selectedPlatform') || DEFAULT_GALGAME_FILTER_VALUE
  )
  const [sortField, setSortField] = useState<SortField>(
    (searchParams.get('sortField') as SortField) || DEFAULT_GALGAME_SORT_FIELD
  )
  const [sortOrder, setSortOrder] = useState<SortOrder>(
    (searchParams.get('sortOrder') as SortOrder) || DEFAULT_GALGAME_SORT_ORDER
  )
  const [selectedYears, setSelectedYears] = useState<string[]>(
    parseGalgameFilterArray(searchParams.get('yearString'))
  )
  const [selectedMonths, setSelectedMonths] = useState<string[]>(
    parseGalgameFilterArray(searchParams.get('monthString'))
  )
  const [minRatingCount, setMinRatingCount] = useState(
    toNumberParam(
      searchParams.get('minRatingCount'),
      DEFAULT_TAG_COMPANY_MIN_RATING_COUNT
    )
  )
  const [debouncedMinRatingCount] = useDebounce(minRatingCount, 400)

  const [company, setCompany] = useState(initialCompany)
  const [patches, setPatches] = useState<GalgameCard[]>(initialPatches)
  const [totalCount, setTotalCount] = useState(total)
  const [loading, setLoading] = useState(false)
  const latestFetchRequestIdRef = useRef(0)
  const withPageReset = <T,>(setter: (value: T) => void) => {
    return (value: T) => {
      setPage(1)
      setter(value)
    }
  }

  const fetchPatches = async () => {
    const requestId = latestFetchRequestIdRef.current + 1
    latestFetchRequestIdRef.current = requestId

    setLoading(true)

    try {
      const response = await kunFetchGet<
        | {
            galgames: GalgameCard[]
            total: number
          }
        | string
      >('/company/galgame', {
        companyId: company.id,
        page,
        limit: 24,
        selectedType,
        selectedLanguage,
        selectedPlatform,
        sortField,
        sortOrder,
        yearString: JSON.stringify(selectedYears),
        monthString: JSON.stringify(selectedMonths),
        minRatingCount: sortField === 'rating' ? debouncedMinRatingCount : 0
      })

      if (requestId !== latestFetchRequestIdRef.current) {
        return
      }

      if (typeof response === 'string') {
        kunErrorHandler(response, () => {})
        setPatches([])
        setTotalCount(0)
        return
      }

      if (
        kunShouldResetOverflowPage(
          response.total,
          response.galgames.length,
          page
        )
      ) {
        setPage(1)
        return
      }

      setPatches(response.galgames)
      setTotalCount(response.total)
    } catch (error) {
      if (requestId !== latestFetchRequestIdRef.current) {
        return
      }

      setPatches([])
      setTotalCount(0)
      errorReporter(error)
    } finally {
      if (requestId === latestFetchRequestIdRef.current) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!isMounted) {
      // 首屏用 SSR 数据不 fetch, 直达 overflow URL 时借 setPage 触发本 effect 重跑
      if (kunShouldResetOverflowPage(totalCount, patches.length, page)) {
        setPage(1)
      }
      return
    }
    fetchPatches()
  }, [
    page,
    selectedType,
    selectedLanguage,
    selectedPlatform,
    sortField,
    sortOrder,
    selectedYears,
    selectedMonths,
    sortField === 'rating' ? debouncedMinRatingCount : null
  ])

  return (
    <div className="w-full my-4 space-y-6">
      <KunHeader
        name={company.name}
        description={company.introduction}
        headerEndContent={
          <Chip size="lg" color="primary">
            {company.count} 个 Galgame
          </Chip>
        }
        endContent={
          <div className="flex justify-between mb-4">
            <KunUser
              user={company.user}
              userProps={{
                name: company.user.name,
                description: (
                  <>
                    创建于 <KunTimeAgo date={company.created} />
                  </>
                ),
                avatarProps: {
                  src: company.user?.avatar
                }
              }}
            />

            {user.role > 2 && (
              <div className="flex gap-2">
                <Button
                  variant="flat"
                  color="primary"
                  onPress={() => {
                    setHasOpenedEdit(true)
                    onOpen()
                  }}
                  onPointerEnter={preloadCompanyFormModal}
                  onFocus={preloadCompanyFormModal}
                  startContent={<Pencil />}
                >
                  编辑会社信息
                </Button>
                <DeleteCompanyModal company={company} />
              </div>
            )}
            {hasOpenedEdit && (
              <CompanyFormModal
                type="edit"
                company={company}
                isOpen={isOpen}
                onClose={onClose}
                onSuccess={(newCompany) => {
                  setCompany(newCompany as CompanyDetail)
                  onClose()
                  router.refresh()
                }}
              />
            )}
          </div>
        }
      />

      {company.alias.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-semibold">别名</h2>
          <div className="flex flex-wrap gap-2">
            {company.alias.map((alias, index) => (
              <Chip key={index} variant="flat" color="secondary">
                {alias}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {company.official_website.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-semibold">官网地址</h2>
          <div className="flex flex-wrap gap-2">
            {company.official_website.map((site, index) => (
              <Link showAnchorIcon isExternal href={site} key={index}>
                {site}
              </Link>
            ))}
          </div>
        </div>
      )}

      {company.primary_language.length > 0 && (
        <div>
          <h2 className="mb-4 text-lg font-semibold">主语言</h2>
          <div className="flex flex-wrap gap-2">
            {company.primary_language.map((language, index) => (
              <Chip key={index} variant="flat" color="success">
                {SUPPORTED_LANGUAGE_MAP[language]}
              </Chip>
            ))}
          </div>
        </div>
      )}

      <FilterBar
        selectedType={selectedType}
        setSelectedType={withPageReset(setSelectedType)}
        selectedLanguage={selectedLanguage}
        setSelectedLanguage={withPageReset(setSelectedLanguage)}
        selectedPlatform={selectedPlatform}
        setSelectedPlatform={withPageReset(setSelectedPlatform)}
        sortField={sortField}
        setSortField={withPageReset(setSortField)}
        sortOrder={sortOrder}
        setSortOrder={withPageReset(setSortOrder)}
        selectedYears={selectedYears}
        setSelectedYears={withPageReset(setSelectedYears)}
        selectedMonths={selectedMonths}
        setSelectedMonths={withPageReset(setSelectedMonths)}
        minRatingCount={minRatingCount}
        // 该值经 400ms debounce 后才进入查询依赖, 包 withPageReset 会让 page
        // 先于 debounced 值变化, 多发一次用旧阈值的请求
        setMinRatingCount={setMinRatingCount}
        defaultMinRatingCount={DEFAULT_TAG_COMPANY_MIN_RATING_COUNT}
        endYear={filterEndYear}
      />

      {company.parent_brand.length > 0 && (
        <div>
          <h2 className="mb-4 text-lg font-semibold">父会社</h2>
          <div className="flex flex-wrap gap-2">
            {company.parent_brand.map((brand, index) => (
              <Chip key={index} variant="flat" color="primary">
                {brand}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <KunLoading hint="正在获取 Galgame 中..." className="min-h-[50vh]" />
      ) : (
        <div>
          <div className="grid grid-cols-2 gap-2 mx-auto mb-8 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {patches.map((patch) => (
              <GalgameCard key={patch.id} patch={patch} />
            ))}
          </div>

          {totalCount > 24 && (
            <div className="flex justify-center">
              <KunPagination
                total={Math.ceil(totalCount / 24)}
                page={page}
                onPageChange={setPage}
                isLoading={loading}
              />
            </div>
          )}

          {!totalCount && (
            <KunNull message="暂无 Galgame, 或您未开启网站 NSFW" />
          )}
        </div>
      )}
    </div>
  )
}
