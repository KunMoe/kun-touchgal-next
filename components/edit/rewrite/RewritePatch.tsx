'use client'

import { useShallow } from 'zustand/react/shallow'
import { useState } from 'react'
import { Button, Card, CardBody, CardHeader } from '@heroui/react'
import { useRewritePatchStore } from '~/store/rewriteStore'
import { KunDualEditorProvider } from '~/components/kun/milkdown/DualEditorProvider'
import toast from 'react-hot-toast'
import { kunFetchPut } from '~/utils/kunFetch'
import { errorReporter, kunErrorHandler } from '~/utils/kunErrorHandler'
import { patchUpdateSchema } from '~/validations/edit'
import { useRouter } from '@bprogress/next/app'
import { GameNameInput } from './GameNameInput'
import { AliasManager } from './AliasManager'
import { ContentLimit } from './ContentLimit'
import { BatchTag } from '../components/BatchTag'
import { ReleaseDateInput } from '../components/ReleaseDateInput'
import { CompanySummary } from '../components/CompanySummary'
import { VNDBInput } from '../create/VNDBInput'
import { VNDBRelationInput } from '../create/VNDBRelationInput'
import { BangumiInput } from '../create/BangumiInput'
import { SteamInput } from '../create/SteamInput'
import { DLSiteInput } from '../create/DLSiteInput'
import type { RewritePatchData } from '~/store/rewriteStore'

export const RewritePatch = () => {
  const router = useRouter()
  const { data, setData } = useRewritePatchStore(
    useShallow((state) => ({ data: state.data, setData: state.setData }))
  )
  const [errors, setErrors] = useState<
    Partial<Record<keyof RewritePatchData, string>>
  >({})

  const addAlias = (newAlias: string) => {
    const alias = newAlias.trim()
    if (data.alias.includes(alias)) {
      toast.error('请不要使用重复的别名')
      return
    }
    if (newAlias.trim()) {
      setData({ ...data, alias: [...data.alias, alias] })
    }
  }

  const [rewriting, setRewriting] = useState(false)
  const handleSubmit = async () => {
    const result = patchUpdateSchema.safeParse(data)
    if (!result.success) {
      const newErrors: Partial<Record<keyof RewritePatchData, string>> = {}
      result.error.issues.forEach((err) => {
        if (err.path.length) {
          newErrors[err.path[0] as keyof RewritePatchData] = err.message
          toast.error(err.message)
        }
      })
      setErrors(newErrors)
      return
    } else {
      setErrors({})
    }

    setRewriting(true)

    try {
      const res = await kunFetchPut<KunResponse<{}>>('/edit', { ...data })
      kunErrorHandler(res, () => {
        toast.success('重新编辑成功')
        router.push(`/${data.uniqueId}`)
      })
    } catch (error) {
      errorReporter(error)
    } finally {
      setRewriting(false)
    }
  }

  return (
    <form className="flex-1 w-full p-4 mx-auto">
      <Card className="w-full">
        <CardHeader className="flex gap-3">
          <div className="flex flex-col">
            <p className="text-2xl">编辑游戏信息</p>
          </div>
        </CardHeader>
        <CardBody className="mt-4 space-y-12">
          <VNDBInput data={data} setData={setData} errors={errors.vndbId} />
          <VNDBRelationInput
            data={data}
            setData={setData}
            errors={errors.vndbRelationId}
            excludeId={data.id}
          />
          <BangumiInput
            data={data}
            setData={setData}
            errors={errors.bangumiId}
            excludeId={data.id}
          />
          <SteamInput
            data={data}
            setData={setData}
            errors={errors.steamId}
            excludeId={data.id}
          />
          <DLSiteInput
            data={data}
            setData={setData}
            errors={errors.dlsiteCode}
            excludeId={data.id}
          />

          <GameNameInput
            name={data.name}
            onChange={(name) => setData({ ...data, name })}
            error={errors.name}
          />

          <div className="space-y-2">
            <h2 className="text-xl">游戏介绍 (必须)</h2>
            {errors.introduction && (
              <p className="text-xs text-danger-500">{errors.introduction}</p>
            )}
            <KunDualEditorProvider storeName="patchRewrite" />
          </div>

          <CompanySummary data={data} />

          <AliasManager
            aliasList={data.alias}
            onAddAlias={addAlias}
            onRemoveAlias={(index) =>
              setData({
                ...data,
                alias: data.alias.filter((_, i) => i !== index)
              })
            }
            onReorderAlias={(nextAlias) =>
              setData({
                ...data,
                alias: nextAlias
              })
            }
            errors={errors.alias}
          />

          <ReleaseDateInput
            date={data.released}
            setDate={(date) => {
              setData({ ...data, released: date })
            }}
            errors={errors.released}
          />

          <BatchTag
            data={data}
            saveTag={(tag) =>
              setData({
                ...data,
                tag
              })
            }
            errors={errors.tag}
          />

          <ContentLimit errors={errors.contentLimit} />

          <Button
            color="primary"
            className="w-full mt-4"
            onPress={handleSubmit}
            isLoading={rewriting}
            isDisabled={rewriting}
          >
            提交
          </Button>
        </CardBody>
      </Card>
    </form>
  )
}
