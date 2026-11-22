'use client'

import { useRef, useState } from 'react'
import { Button, Input } from '@heroui/react'
import toast from 'react-hot-toast'
import { kunFetchGet, kunFetchPost } from '~/utils/kunFetch'
import { fetchVNDBDetails } from '~/utils/vndb'
import { normalizeExternalId } from '~/utils/normalizeExternalId'
import { FetchPreview } from '~/components/edit/components/FetchPreview'
import {
  applyFetchMerge,
  buildDuplicateCheckQuery,
  combineVndbRelationFetch,
  fetchedForCurrentId,
  mergeVndbRelationFetch
} from '~/components/edit/form/merge'
import type { KunFormUpdate, PatchFormDataShape } from '~/components/edit/types'
import type {
  KunFetchedFor,
  VndbRelationFetchResult
} from '~/components/edit/form/merge'

interface RelationResponse {
  vndbId: string
  titles: string[]
  released: string
}

interface Props {
  errors?: string
  data: PatchFormDataShape
  update: KunFormUpdate<PatchFormDataShape>
  enableDuplicateCheck?: boolean
  excludeId?: number
}

export const VNDBRelationInput = ({
  errors,
  data,
  update,
  enableDuplicateCheck = true,
  excludeId
}: Props) => {
  const [fetched, setFetched] =
    useState<KunFetchedFor<VndbRelationFetchResult> | null>(null)
  // 只认最后一次发起的抓取, 较早的应答晚到时丢弃
  const tokenRef = useRef(0)
  const preview = fetchedForCurrentId(
    fetched,
    'vndbRelation',
    data.vndbRelationId
  )

  const handleFetchRelation = async () => {
    const requestedId = normalizeExternalId('vndbRelation', data.vndbRelationId)
    if (!requestedId) {
      toast.error('VNDB Relation ID 不可为空')
      return
    }

    if (!/^r\d+$/.test(requestedId)) {
      toast.error('Relation ID 需要以 r 开头')
      return
    }

    const token = ++tokenRef.current
    const isStale = () => token !== tokenRef.current

    try {
      toast('正在获取 Release 数据...')
      const relationResult = await kunFetchPost<KunResponse<RelationResponse>>(
        '/edit/vndb/relation',
        {
          relationId: requestedId
        }
      )
      if (isStale()) {
        return
      }

      if (typeof relationResult === 'string') {
        toast.error(relationResult)
        return
      }

      if (enableDuplicateCheck) {
        const duplicateResult = await kunFetchGet<
          KunResponse<{ uniqueId: string }>
        >(
          '/edit/duplicate',
          buildDuplicateCheckQuery('vndbRelation', requestedId, {
            vndbId: relationResult.vndbId,
            excludeId
          })
        )
        if (isStale()) {
          return
        }

        if (typeof duplicateResult === 'string') {
          toast.error(duplicateResult)
          return
        }

        if (duplicateResult?.uniqueId) {
          toast.error(
            `与 VN 已重复 (ID: ${duplicateResult.uniqueId}), 请勿重复提交`
          )
          return
        }
      }

      toast('正在同步 VNDB 数据...')
      const details = await fetchVNDBDetails(relationResult.vndbId)
      if (isStale()) {
        return
      }
      if (typeof details === 'string') {
        setFetched(null)
        toast.error(details)
        return
      }

      const result = combineVndbRelationFetch(relationResult, details)
      const applied = applyFetchMerge(update, (prev) =>
        mergeVndbRelationFetch(prev, requestedId, result)
      )
      if (!applied) {
        return
      }
      setFetched({ forId: requestedId, data: result })

      toast.success('已获取 Release 数据! 并完成 VNDB 同步')
    } catch (error) {
      if (isStale()) {
        return
      }
      setFetched(null)
      toast.error('获取 Release 数据失败, 请稍后重试')
    }
  }

  return (
    <div className="w-full space-y-2">
      <h2 className="text-xl">VNDB Relation ID (可选)</h2>
      <Input
        variant="underlined"
        labelPlacement="outside"
        placeholder="请输入 Release ID, 例如 r5879"
        value={data.vndbRelationId}
        onChange={(e) => update({ vndbRelationId: e.target.value })}
        isInvalid={!!errors}
        errorMessage={errors}
      />
      <p className="text-sm text-default-500">
        Relation ID 可用于发布特定版本 (如移植、合集等)
        的信息，我们会自动读取关联 VN 的数据并保留当前版本的标题与发售日期
      </p>
      <div className="flex items-center text-sm">
        {data.vndbRelationId && (
          <Button
            className="mr-4"
            color="primary"
            size="sm"
            onPress={handleFetchRelation}
          >
            获取 Release 数据
          </Button>
        )}
      </div>
      {preview && (
        <FetchPreview
          fields={[
            { label: '关联 VNDB ID', value: preview.vndbId },
            {
              label: '别名',
              value: preview.titles.filter((title) => title !== data.name)
            },
            { label: '标签', value: preview.tags },
            { label: '开发商', value: preview.developers },
            { label: '发售日期', value: preview.released }
          ]}
        />
      )}
    </div>
  )
}
