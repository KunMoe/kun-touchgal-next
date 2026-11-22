'use client'

import { useRef, useState } from 'react'
import { Button, Input } from '@heroui/react'
import toast from 'react-hot-toast'
import { fetchVNDBDetails } from '~/utils/vndb'
import { normalizeExternalId } from '~/utils/normalizeExternalId'
import { FetchPreview } from '~/components/edit/components/FetchPreview'
import {
  applyFetchMerge,
  fetchedForCurrentId,
  mergeVndbFetch
} from '~/components/edit/form/merge'
import type { KunFormUpdate, PatchFormDataShape } from '~/components/edit/types'
import type {
  KunFetchedFor,
  VndbFetchResult
} from '~/components/edit/form/merge'

interface Props {
  errors: string | undefined
  data: PatchFormDataShape
  update: KunFormUpdate<PatchFormDataShape>
}

export const VNDBInput = ({ errors, data, update }: Props) => {
  const [fetched, setFetched] = useState<KunFetchedFor<VndbFetchResult> | null>(
    null
  )
  // 只认最后一次发起的抓取, 较早的应答晚到时丢弃
  const tokenRef = useRef(0)
  const preview = fetchedForCurrentId(fetched, 'vndb', data.vndbId)

  const handleFetchData = async () => {
    const requestedId = normalizeExternalId('vndb', data.vndbId)
    if (!requestedId) {
      toast.error('VNDB ID 不可为空')
      return
    }

    if (!/^v\d+$/.test(requestedId)) {
      toast.error('VNDB ID 需要以 v 开头')
      return
    }

    const token = ++tokenRef.current
    const isStale = () => token !== tokenRef.current

    try {
      toast('正在从 VNDB 获取数据...')
      const result = await fetchVNDBDetails(requestedId)
      if (isStale()) {
        return
      }
      if (typeof result === 'string') {
        setFetched(null)
        toast.error(result)
        return
      }

      const applied = applyFetchMerge(update, (prev) =>
        mergeVndbFetch(prev, requestedId, result)
      )
      if (!applied) {
        return
      }
      setFetched({ forId: requestedId, data: result })

      toast.success('获取数据成功! 已为您自动添加游戏别名')
    } catch (error) {
      if (isStale()) {
        return
      }
      setFetched(null)
      toast.error('VNDB API 请求失败, 请稍后重试')
    }
  }

  return (
    <div className="w-full space-y-2">
      <h2 className="text-xl">VNDB ID (可选)</h2>
      <Input
        variant="underlined"
        labelPlacement="outside"
        placeholder="请输入 VNDB ID, 例如 v19658"
        value={data.vndbId}
        onChange={(e) => update({ vndbId: e.target.value })}
        isInvalid={!!errors}
        errorMessage={errors}
      />
      <div className="flex items-center text-sm">
        {data.vndbId && (
          <Button
            className="mr-4"
            color="primary"
            size="sm"
            onPress={handleFetchData}
          >
            获取 VNDB 数据
          </Button>
        )}
      </div>
      {preview && (
        <FetchPreview
          fields={[
            { label: '别名', value: preview.titles },
            { label: '标签', value: preview.tags },
            { label: '开发商', value: preview.developers },
            { label: '发售日期', value: preview.released }
          ]}
        />
      )}
    </div>
  )
}
