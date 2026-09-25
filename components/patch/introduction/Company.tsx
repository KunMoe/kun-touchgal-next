'use client'

import { type FC, useState, useTransition } from 'react'
import { Chip } from '@heroui/chip'
import { Tooltip } from '@heroui/tooltip'
import { Link } from '@heroui/link'
import { Button } from '@heroui/button'
import { Download } from 'lucide-react'
import { Company } from '~/types/api/company'
import dynamic from 'next/dynamic'
import { useUserStore } from '~/store/userStore'
import { kunFetchPost } from '~/utils/kunFetch'
import toast from 'react-hot-toast'

const PatchCompanySelector = dynamic(
  () =>
    import('./PatchCompanySelector').then((mod) => mod.PatchCompanySelector),
  { ssr: false }
)

interface Props {
  patchId: number
  initialCompanies: Company[]
  vndbId: string | null
  bangumiId?: number | null
  steamId?: number | null
  dlsiteCode?: string | null
}

interface FetchCompanyResponse {
  message: string
  companies: Company[]
}

export const PatchCompany: FC<Props> = ({
  patchId,
  initialCompanies,
  vndbId,
  bangumiId,
  steamId,
  dlsiteCode
}) => {
  const [selectedCompanies, setSelectedCompanies] = useState<Company[]>(
    initialCompanies ?? []
  )
  const user = useUserStore((state) => state.user)
  const [isFetching, startTransition] = useTransition()

  const handleFetchCompanies = () => {
    startTransition(async () => {
      const response = await kunFetchPost<FetchCompanyResponse | string>(
        '/patch/introduction/company/fetch',
        { patchId }
      )

      if (typeof response === 'string') {
        toast.error(response)
        return
      }

      toast.success(response.message)
      setSelectedCompanies(response.companies)
    })
  }

  const hasExternalSource = Boolean(
    vndbId || bangumiId || steamId || dlsiteCode
  )
  const showFetchButton =
    user.role > 2 && selectedCompanies.length === 0 && hasExternalSource

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-2xl font-medium">所属会社</h2>

        {showFetchButton && (
          <Tooltip content="从 VNDB / Bangumi / Steam / DLsite 获取并关联会社信息">
            <Button
              size="sm"
              color="secondary"
              variant="flat"
              isLoading={isFetching}
              onPress={handleFetchCompanies}
              startContent={!isFetching && <Download size={16} />}
            >
              获取关联会社
            </Button>
          </Tooltip>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {selectedCompanies.map((company) => (
          <Tooltip
            key={company.id}
            content={`${company.count} 个 Galgame 属于此会社`}
          >
            <Link href={`/company/${company.id}`}>
              <Chip color="secondary" variant="flat">
                {company.name}
                {` +${company.count}`}
              </Chip>
            </Link>
          </Tooltip>
        ))}

        {!selectedCompanies.length && (
          <Chip>{'这个 Galgame 本体暂未添加所属会社信息'}</Chip>
        )}
      </div>

      {user.role > 2 && (
        <PatchCompanySelector
          patchId={patchId}
          initialCompanies={selectedCompanies}
          onCompanyChange={setSelectedCompanies}
        />
      )}
    </div>
  )
}
