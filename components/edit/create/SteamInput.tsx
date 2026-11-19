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
  mergeSteamFetch,
  steamAliasTitles
} from '~/components/edit/form/merge'
import type { KunFormUpdate, PatchFormDataShape } from '~/components/edit/types'
import type {
  KunFetchedFor,
  SteamFetchResult
} from '~/components/edit/form/merge'

interface Props {
  errors?: string
  data: PatchFormDataShape
  update: KunFormUpdate<PatchFormDataShape>
  excludeId?: number
}

export const SteamInput = ({ errors, data, update, excludeId }: Props) => {
  const [fetched, setFetched] =
    useState<KunFetchedFor<SteamFetchResult> | null>(null)
  const [duplicate, setDuplicate] = useState<KunFetchedFor<string> | null>(null)
  // 只认最后一次发起的抓取, 较早的应答晚到时丢弃
  const tokenRef = useRef(0)
  const preview = fetchedForCurrentId(fetched, 'steam', data.steamId)
  const duplicateUniqueId = fetchedForCurrentId(
    duplicate,
    'steam',
    data.steamId
  )

  const handleFetch = async () => {
    const requestedId = normalizeExternalId('steam', data.steamId)
    if (!requestedId) {
      toast.error('Steam ID 不可为空')
      return
    }

    if (!/^\d+$/.test(requestedId)) {
      toast.error('Steam ID 必须为纯数字')
      return
    }

    const token = ++tokenRef.current
    const isStale = () => token !== tokenRef.current

    const duplicateResult = await kunFetchGet<
      KunResponse<{ uniqueId: string }>
    >(
      '/edit/duplicate',
      buildDuplicateCheckQuery('steam', requestedId, { excludeId })
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
      toast('正在从 Steam 获取数据...')
      const result = await kunFetchPost<KunResponse<SteamFetchResult>>(
        '/edit/steam',
        { steamId: requestedId }
      )
      if (isStale()) {
        return
      }

      if (typeof result === 'string') {
        toast.error(result)
        return
      }

      if (!result?.name) {
        toast.error('未找到对应的 Steam 游戏')
        return
      }

      const applied = applyFetchMerge(update, (prev) =>
        mergeSteamFetch(prev, requestedId, result)
      )
      if (!applied) {
        return
      }
      setFetched({ forId: requestedId, data: result })

      toast.success(`确认: ${result.name}`)
    } catch (error) {
      if (isStale()) {
        return
      }
      setFetched(null)
      toast.error('Steam API 请求失败, 请稍后重试')
    }
  }

  return (
    <div className="w-full space-y-2">
      <h2 className="text-xl">Steam ID (可选)</h2>
      <Input
        variant="underlined"
        labelPlacement="outside"
        placeholder="请输入 Steam App ID, 例如 3655150"
        value={data.steamId}
        onChange={(e) => update({ steamId: e.target.value })}
        isInvalid={!!errors}
        errorMessage={errors}
      />
      <div className="flex items-center gap-2 text-sm">
        {data.steamId && (
          <Button color="primary" size="sm" onPress={handleFetch}>
            获取 Steam 数据
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
            { label: '游戏名', value: preview.name },
            { label: '别名', value: steamAliasTitles(preview) },
            { label: '标签', value: preview.tags },
            { label: '发售日期', value: preview.releaseDate },
            {
              label: '开发商',
              value: preview.developers.map((d) => d.name)
            }
          ]}
        />
      )}
    </div>
  )
}
