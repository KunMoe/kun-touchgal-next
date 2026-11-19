'use client'

import { useState } from 'react'
import { Button } from '@heroui/react'
import toast from 'react-hot-toast'
import Link from 'next/link'
import localforage from 'localforage'
import { createPatchEditStoreKey, useCreatePatchStore } from '~/store/editStore'
import { kunFetchGet } from '~/utils/kunFetch'
import { normalizeExternalId } from '~/utils/normalizeExternalId'

interface DuplicateResponse {
  uniqueId: string
}

export const DuplicateCheckButton = () => {
  const data = useCreatePatchStore((state) => state.data)
  const [checking, setChecking] = useState(false)
  const [duplicateUniqueId, setDuplicateUniqueId] = useState<string | null>(
    null
  )

  const buildPayload = () => ({
    vndbId: normalizeExternalId('vndb', data.vndbId),
    vndbRelationId: normalizeExternalId('vndbRelation', data.vndbRelationId),
    dlsiteCode: normalizeExternalId('dlsite', data.dlsiteCode),
    title: data.name.trim()
  })

  const handleCheckDuplicate = async () => {
    const payload = buildPayload()

    if (
      !payload.vndbId &&
      !payload.vndbRelationId &&
      !payload.dlsiteCode &&
      !payload.title
    ) {
      toast.error('请至少填写一个可用的查重字段')
      return
    }

    setChecking(true)
    setDuplicateUniqueId(null)
    try {
      const response = await kunFetchGet<KunResponse<DuplicateResponse>>(
        '/edit/duplicate',
        {
          vndbId: payload.vndbId,
          vndbRelationId: payload.vndbRelationId,
          dlsiteCode: payload.dlsiteCode,
          title: payload.title
        }
      )

      if (typeof response === 'string') {
        toast.error(response)
        return
      }

      if (response?.uniqueId) {
        setDuplicateUniqueId(response.uniqueId)
        toast.error('发现重复记录, 点击跳转到重复的游戏')
      } else {
        toast.success('检查完成, 未找到重复游戏')
      }
    } catch (error) {
      toast.error('查重失败, 请稍后再试')
    } finally {
      setChecking(false)
    }
  }

  const handleClearDraft = async () => {
    localStorage.removeItem(createPatchEditStoreKey)
    await localforage.removeItem('kun-patch-banner')
    await localforage.removeItem('kun-patch-banner-original')
    window.location.reload()
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
      <Button
        color="secondary"
        size="sm"
        onPress={handleCheckDuplicate}
        isDisabled={checking}
        isLoading={checking}
      >
        检查重复
      </Button>

      <Button
        color="danger"
        variant="flat"
        size="sm"
        onPress={handleClearDraft}
      >
        清除本地草稿
      </Button>

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
  )
}
