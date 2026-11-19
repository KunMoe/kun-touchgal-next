'use client'

import { useRef, useState } from 'react'
import { Button, Input } from '@heroui/react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { kunFetchGet, kunFetchPost } from '~/utils/kunFetch'
import { normalizeExternalId } from '~/utils/normalizeExternalId'
import { FetchPreview } from '~/components/edit/components/FetchPreview'
import {
  applyFetchMerge,
  buildDuplicateCheckQuery,
  fetchedForCurrentId,
  mergeDlsiteFetch,
  parseDlsiteTags
} from '~/components/edit/form/merge'
import type { KunFormUpdate, PatchFormDataShape } from '~/components/edit/types'
import type {
  DlsiteFetchResult,
  KunFetchedFor
} from '~/components/edit/form/merge'

interface Props {
  errors?: string
  data: PatchFormDataShape
  update: KunFormUpdate<PatchFormDataShape>
  excludeId?: number
}

export const DLSiteInput = ({ errors, data, update, excludeId }: Props) => {
  const [fetched, setFetched] =
    useState<KunFetchedFor<DlsiteFetchResult> | null>(null)
  const [duplicate, setDuplicate] = useState<KunFetchedFor<string> | null>(null)
  // 只认最后一次发起的抓取, 较早的应答晚到时丢弃
  const tokenRef = useRef(0)
  const preview = fetchedForCurrentId(fetched, 'dlsite', data.dlsiteCode)
  const duplicateUniqueId = fetchedForCurrentId(
    duplicate,
    'dlsite',
    data.dlsiteCode
  )

  const handleFetch = async () => {
    const requestedId = normalizeExternalId('dlsite', data.dlsiteCode)
    if (!requestedId) {
      toast.error('DLSite Code 不可为空')
      return
    }

    if (!/^(RJ|VJ)\d+$/.test(requestedId)) {
      toast.error('DLSite Code 需要以 RJ 或 VJ 开头')
      return
    }

    const token = ++tokenRef.current
    const isStale = () => token !== tokenRef.current

    const duplicateResult = await kunFetchGet<
      KunResponse<{ uniqueId: string }>
    >(
      '/edit/duplicate',
      buildDuplicateCheckQuery('dlsite', requestedId, { excludeId })
    )
    if (isStale()) {
      return
    }

    if (typeof duplicateResult !== 'string' && duplicateResult?.uniqueId) {
      setDuplicate({ forId: requestedId, data: duplicateResult.uniqueId })
      toast.error('发现重复游戏条目, 请勿重复提交')
      return
    }
    setDuplicate(null)

    try {
      toast('正在从 DLSite 获取数据...')
      const result = await kunFetchPost<KunResponse<DlsiteFetchResult>>(
        '/edit/dlsite',
        { code: requestedId }
      )
      if (isStale()) {
        return
      }

      if (typeof result === 'string') {
        toast.error(result)
        return
      }

      if (!result?.title_default) {
        toast.error('未找到对应的 DLSite 数据')
        return
      }

      const applied = applyFetchMerge(update, (prev) =>
        mergeDlsiteFetch(prev, requestedId, result)
      )
      if (!applied) {
        return
      }
      setFetched({ forId: requestedId, data: result })

      toast.success('已获取 DLSite 数据并自动写入表单')
    } catch (error) {
      if (isStale()) {
        return
      }
      setFetched(null)
      toast.error('DLSite API 请求失败, 请稍后重试')
    }
  }

  return (
    <div className="w-full space-y-2">
      <h2 className="text-xl">DLSite Code (可选)</h2>
      <Input
        variant="underlined"
        labelPlacement="outside"
        placeholder="请输入 DLSite Code, 例如 RJ01405813 或 VJ012345"
        value={data.dlsiteCode}
        onChange={(e) => update({ dlsiteCode: e.target.value })}
        isInvalid={!!errors}
        errorMessage={errors}
      />
      <div className="flex items-center gap-2 text-sm">
        {data.dlsiteCode && (
          <Button color="primary" size="sm" onPress={handleFetch}>
            获取 DLSite 数据
          </Button>
        )}
        {duplicateUniqueId && (
          <Button
            as={Link}
            color="primary"
            target="_blank"
            href={`/${duplicateUniqueId}`}
            variant="flat"
            size="sm"
          >
            跳转到重复游戏
          </Button>
        )}
      </div>
      {preview && (
        <FetchPreview
          fields={[
            { label: '默认标题', value: preview.title_default },
            { label: '日文标题', value: preview.title_jp?.trim() ?? '' },
            { label: '英文标题', value: preview.title_en?.trim() ?? '' },
            { label: '标签', value: parseDlsiteTags(preview.tags) },
            { label: '社团', value: preview.circle_name?.trim() ?? '' },
            { label: '发售日期', value: preview.release_date ?? '' }
          ]}
        />
      )}
    </div>
  )
}
