'use client'

import { useCallback, useState } from 'react'
import { useStore } from 'zustand'
import { Button, Card, CardBody, CardHeader } from '@heroui/react'
import { createRewriteFormStore } from '~/store/rewriteStore'
import { KunDualEditorProvider } from '~/components/kun/milkdown/DualEditorProvider'
import toast from 'react-hot-toast'
import { kunFetchPut } from '~/utils/kunFetch'
import { errorReporter, kunErrorHandler } from '~/utils/kunErrorHandler'
import { patchUpdateSchema } from '~/validations/edit'
import { useRouter } from '@bprogress/next/app'
import { normalizeStringArray } from '~/utils/normalizeStringArray'
import { removePatchNameFromAlias } from '~/utils/removePatchNameFromAlias'
import { GameNameInput } from './GameNameInput'
import { AliasManager } from './AliasManager'
import { ContentLimit } from './ContentLimit'
import { TagField } from '../components/TagField'
import { ReleaseDateInput } from '../components/ReleaseDateInput'
import { CompanySummary } from '../components/CompanySummary'
import { VNDBInput } from '../create/VNDBInput'
import { VNDBRelationInput } from '../create/VNDBRelationInput'
import { BangumiInput } from '../create/BangumiInput'
import { SteamInput } from '../create/SteamInput'
import { DLSiteInput } from '../create/DLSiteInput'
import type * as z from 'zod'
import type { GalgameRewriteInitial } from '~/types/api/edit'

type SubmitErrors = Partial<
  Record<keyof z.infer<typeof patchUpdateSchema>, string>
>

interface Props {
  initial: GalgameRewriteInitial
}

export const RewritePatch = ({ initial }: Props) => {
  const router = useRouter()
  // 表单 store 用页面读到的基线建一次, 随本组件存活。只在这里读 initial: 之后页面
  // 再下发新的基线, 也不拿它去配已经填了一半的表单
  const [store] = useState(() => createRewriteFormStore(initial))
  const data = useStore(store, (state) => state.data)
  const update = useStore(store, (state) => state.update)
  const existingTags = useStore(store, (state) => state.existingTags)
  const baseFingerprint = useStore(store, (state) => state.baseFingerprint)
  const [errors, setErrors] = useState<SubmitErrors>({})

  const getIntroduction = useCallback(
    () => store.getState().data.introduction,
    [store]
  )
  const setIntroduction = useCallback(
    (introduction: string) => store.getState().update({ introduction }),
    [store]
  )

  const addAlias = (newAlias: string) => {
    const alias = newAlias.trim()
    if (data.alias.includes(alias)) {
      toast.error('请不要使用重复的别名')
      return
    }
    if (alias) {
      update((prev) => ({ alias: [...prev.alias, alias] }))
    }
  }

  const [rewriting, setRewriting] = useState(false)
  const handleSubmit = async () => {
    // 标签按意图提交: 现存的只报要移除的 id, 文本框里的是要新增的名字。
    // 不回传「现存标签的名字全集」: 那份名单一旦陈旧, 提交就会复活已删的标签
    const { tag, ...fields } = data
    const submitData = {
      ...fields,
      alias: removePatchNameFromAlias(data.alias, data.name),
      addTagNames: normalizeStringArray(tag),
      baseFingerprint
    }
    const result = patchUpdateSchema.safeParse(submitData)
    if (!result.success) {
      const newErrors: SubmitErrors = {}
      result.error.issues.forEach((err) => {
        if (err.path.length) {
          newErrors[err.path[0] as keyof SubmitErrors] = err.message
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
      const res = await kunFetchPut<KunResponse<{}>>('/edit', submitData)
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
          <VNDBInput data={data} update={update} errors={errors.vndbId} />
          <VNDBRelationInput
            data={data}
            update={update}
            errors={errors.vndbRelationId}
            excludeId={data.id}
          />
          <BangumiInput
            data={data}
            update={update}
            errors={errors.bangumiId}
            excludeId={data.id}
          />
          <SteamInput
            data={data}
            update={update}
            errors={errors.steamId}
            excludeId={data.id}
          />
          <DLSiteInput
            data={data}
            update={update}
            errors={errors.dlsiteCode}
            excludeId={data.id}
          />

          <GameNameInput
            name={data.name}
            onChange={(name) => update({ name })}
            error={errors.name}
          />

          <div className="space-y-2">
            <h2 className="text-xl">游戏介绍 (必须)</h2>
            {errors.introduction && (
              <p className="text-xs text-danger-500">{errors.introduction}</p>
            )}
            <KunDualEditorProvider
              getMarkdown={getIntroduction}
              setMarkdown={setIntroduction}
            />
          </div>

          <CompanySummary data={data} update={update} />

          <AliasManager
            aliasList={data.alias}
            onAddAlias={addAlias}
            onRemoveAlias={(index) =>
              update((prev) => ({
                alias: prev.alias.filter((_, i) => i !== index)
              }))
            }
            onReorderAlias={(nextAlias) => update({ alias: nextAlias })}
            errors={errors.alias}
          />

          <ReleaseDateInput
            date={data.released}
            setDate={(date) => {
              update({ released: date })
            }}
            errors={errors.released}
          />

          <TagField
            data={data}
            update={update}
            errors={errors.addTagNames ?? errors.removeTagIds}
            existing={{
              tags: existingTags,
              removeTagIds: data.removeTagIds,
              onToggleRemove: (id) =>
                update((prev) => ({
                  removeTagIds: prev.removeTagIds.includes(id)
                    ? prev.removeTagIds.filter((item) => item !== id)
                    : [...prev.removeTagIds, id]
                }))
            }}
          />

          <ContentLimit
            contentLimit={data.contentLimit}
            onChange={(contentLimit) => update({ contentLimit })}
            errors={errors.contentLimit}
          />

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
