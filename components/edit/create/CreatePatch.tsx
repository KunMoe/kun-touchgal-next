'use client'

import { useShallow } from 'zustand/react/shallow'
import { useEffect, useState } from 'react'
import { Card, CardBody, CardHeader, Input } from '@heroui/react'
import { useCreatePatchStore } from '~/store/editStore'
import { VNDBInput } from './VNDBInput'
import { VNDBRelationInput } from './VNDBRelationInput'
import { BangumiInput } from './BangumiInput'
import { SteamInput } from './SteamInput'
import { DLSiteInput } from './DLSiteInput'
import { AliasInput } from './AliasInput'
import { BannerImage } from './BannerImage'
import { PublishButton } from './PublishButton'
import { PatchIntroduction } from './PatchIntroduction'
import { ContentLimit } from './ContentLimit'
import { DuplicateCheckButton } from './DuplicateCheckButton'
import { TagField } from '../components/TagField'
import { ReleaseDateInput } from '../components/ReleaseDateInput'
import { CompanySummary } from '../components/CompanySummary'
import { KunLoading } from '~/components/kun/Loading'
import type { CreatePatchRequestData } from '~/store/editStore'

export const CreatePatch = () => {
  const { data, update } = useCreatePatchStore(
    useShallow((state) => ({ data: state.data, update: state.update }))
  )
  const [isStoreHydrated, setIsStoreHydrated] = useState(false)
  const [errors, setErrors] = useState<
    Partial<Record<keyof CreatePatchRequestData, string>>
  >({})

  useEffect(() => {
    const persist = useCreatePatchStore.persist
    if (!persist || persist.hasHydrated()) {
      setIsStoreHydrated(true)
      return
    }

    let cancelled = false
    const hydrateStore = async () => {
      await persist.rehydrate()
      if (!cancelled) {
        setIsStoreHydrated(true)
      }
    }

    void hydrateStore()

    return () => {
      cancelled = true
    }
  }, [])

  if (!isStoreHydrated) {
    return <KunLoading className="min-h-96" hint="正在读取本地草稿" />
  }

  return (
    <form className="w-full max-w-5xl py-4 mx-auto">
      <Card className="w-full">
        <CardHeader className="flex gap-3">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl shrink-0">创建新游戏</h1>
              <DuplicateCheckButton />
            </div>

            <p className="mt-2">
              游戏查重会使用 VNDB ID, VNDB Relation ID, DLsite Code
              以及游戏标题和别名进行查重
            </p>
          </div>
        </CardHeader>
        <CardBody className="mt-4 space-y-12">
          <VNDBInput data={data} update={update} errors={errors.vndbId} />
          <VNDBRelationInput
            data={data}
            update={update}
            errors={errors.vndbRelationId}
          />
          <BangumiInput data={data} update={update} errors={errors.bangumiId} />
          <SteamInput data={data} update={update} errors={errors.steamId} />
          <DLSiteInput data={data} update={update} errors={errors.dlsiteCode} />

          <div className="space-y-2">
            <h2 className="text-xl">游戏名称 (必须)</h2>
            <Input
              isRequired
              variant="underlined"
              labelPlacement="outside"
              placeholder="输入游戏名称, 这会作为游戏的标题"
              value={data.name}
              onChange={(e) => update({ name: e.target.value })}
              isInvalid={!!errors.name}
              errorMessage={errors.name}
            />
          </div>

          <BannerImage errors={errors.banner} />

          <PatchIntroduction errors={errors.introduction} />

          <AliasInput errors={errors.alias} />

          <CompanySummary data={data} update={update} />

          <ReleaseDateInput
            date={data.released}
            setDate={(date) => {
              update({ released: date })
            }}
            errors={errors.released}
          />

          <TagField data={data} update={update} errors={errors.tag} />

          <ContentLimit errors={errors.contentLimit} />

          <PublishButton setErrors={setErrors} />
        </CardBody>
      </Card>
    </form>
  )
}
