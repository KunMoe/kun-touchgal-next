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
  mergeBangumiFetch
} from '~/components/edit/form/merge'
import type { KunFormUpdate, PatchFormDataShape } from '~/components/edit/types'
import type {
  BangumiFetchResult,
  KunFetchedFor
} from '~/components/edit/form/merge'

interface Props {
  errors?: string
  data: PatchFormDataShape
  update: KunFormUpdate<PatchFormDataShape>
  excludeId?: number
}

export const BangumiInput = ({ errors, data, update, excludeId }: Props) => {
  const [fetched, setFetched] =
    useState<KunFetchedFor<BangumiFetchResult> | null>(null)
  const [duplicate, setDuplicate] = useState<KunFetchedFor<string> | null>(null)
  // 只认最后一次发起的抓取, 较早的应答晚到时丢弃
  const tokenRef = useRef(0)
  const preview = fetchedForCurrentId(fetched, 'bangumi', data.bangumiId)
  const duplicateUniqueId = fetchedForCurrentId(
    duplicate,
    'bangumi',
    data.bangumiId
  )

  const handleFetch = async () => {
    const requestedId = normalizeExternalId('bangumi', data.bangumiId)
    if (!requestedId) {
      toast.error('Bangumi ID 不可为空')
      return
    }

    if (!/^\d+$/.test(requestedId)) {
      toast.error('Bangumi ID 必须为纯数字')
      return
    }

    const token = ++tokenRef.current
    const isStale = () => token !== tokenRef.current

    const duplicateResult = await kunFetchGet<
      KunResponse<{ uniqueId: string }>
    >(
      '/edit/duplicate',
      buildDuplicateCheckQuery('bangumi', requestedId, { excludeId })
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
      toast('正在从 Bangumi 获取数据...')
      const result = await kunFetchPost<KunResponse<BangumiFetchResult>>(
        '/edit/bangumi',
        { bangumiId: requestedId }
      )
      if (isStale()) {
        return
      }

      if (typeof result === 'string') {
        toast.error(result)
        return
      }

      const displayName = result.nameCn || result.name
      if (!displayName) {
        toast.error('未找到对应的 Bangumi 条目')
        return
      }

      const applied = applyFetchMerge(update, (prev) =>
        mergeBangumiFetch(prev, requestedId, result)
      )
      if (!applied) {
        return
      }
      setFetched({ forId: requestedId, data: result })

      toast.success(`确认: ${displayName}`)
    } catch (error) {
      if (isStale()) {
        return
      }
      setFetched(null)
      toast.error('Bangumi API 请求失败, 请稍后重试')
    }
  }

  return (
    <div className="w-full space-y-2">
      <h2 className="text-xl">Bangumi ID (可选)</h2>
      <Input
        variant="underlined"
        labelPlacement="outside"
        placeholder="请输入 Bangumi 条目 ID, 例如 172612"
        value={data.bangumiId}
        onChange={(e) => update({ bangumiId: e.target.value })}
        isInvalid={!!errors}
        errorMessage={errors}
      />
      <div className="flex items-center gap-2 text-sm">
        {data.bangumiId && (
          <Button color="primary" size="sm" onPress={handleFetch}>
            获取 Bangumi 数据
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
            { label: '名称', value: preview.name },
            { label: '中文名', value: preview.nameCn },
            { label: '发售日期', value: preview.released },
            { label: '标签', value: preview.tags },
            { label: '开发商', value: preview.developers }
          ]}
        />
      )}
    </div>
  )
}
