'use client'

import { useShallow } from 'zustand/react/shallow'
import { useRef, useState } from 'react'
import { Button } from '@heroui/react'
import localforage from 'localforage'
import { useCreatePatchStore } from '~/store/editStore'
import toast from 'react-hot-toast'
import { kunFetchFormData } from '~/utils/kunFetch'
import { kunErrorHandler, errorReporter } from '~/utils/kunErrorHandler'
import { patchCreateSchema } from '~/validations/edit'
import { useRouter } from '@bprogress/next'
import { cn } from '~/utils/cn'
import { normalizeStringArray } from '~/utils/normalizeStringArray'
import type { Dispatch, SetStateAction } from 'react'
import type { CreatePatchRequestData } from '~/store/editStore'

interface Props {
  setErrors: Dispatch<
    SetStateAction<Partial<Record<keyof CreatePatchRequestData, string>>>
  >
  className?: string
}

export const PublishButton = ({ setErrors, className }: Props) => {
  const router = useRouter()
  const { data, resetData } = useCreatePatchStore(
    useShallow((state) => ({ data: state.data, resetData: state.resetData }))
  )

  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const handleSubmit = async () => {
    // 置位必须早于任何 await: 下方 localforage.getItem 是 IndexedDB 异步往返, 期间
    // isDisabled 仍为 false, 双击会让两次提交并发各自 POST /edit, 而未填外部 ID 的
    // 游戏在服务端无唯一约束兜底 (name 不唯一, unique_id 逐次随机), 会落库两条.
    // ref + state 双写照 PublishResource.tsx 的同款提交防抖
    if (creatingRef.current) {
      return
    }
    creatingRef.current = true
    setCreating(true)

    try {
      const localeBannerBlob: Blob | null =
        await localforage.getItem('kun-patch-banner')
      const localeOriginalBannerBlob: Blob | null = await localforage.getItem(
        'kun-patch-banner-original'
      )
      if (!localeBannerBlob) {
        toast.error('未检测到预览图片')
        return
      }

      const sanitizedAlias = normalizeStringArray(data.alias)
      const sanitizedTag = normalizeStringArray(data.tag)

      const result = patchCreateSchema.safeParse({
        ...data,
        banner: localeBannerBlob,
        alias: JSON.stringify(sanitizedAlias),
        tag: JSON.stringify(sanitizedTag),
        vndbTags: JSON.stringify(data.vndbTags),
        vndbDevelopers: JSON.stringify(data.vndbDevelopers),
        bangumiTags: JSON.stringify(data.bangumiTags),
        bangumiDevelopers: JSON.stringify(data.bangumiDevelopers),
        steamTags: JSON.stringify(data.steamTags),
        steamDevelopers: JSON.stringify(data.steamDevelopers),
        steamAliases: JSON.stringify(data.steamAliases)
      })
      if (!result.success) {
        const newErrors: Partial<Record<keyof CreatePatchRequestData, string>> =
          {}
        result.error.issues.forEach((err) => {
          if (err.path.length) {
            newErrors[err.path[0] as keyof CreatePatchRequestData] = err.message
            toast.error(err.message)
          }
        })
        setErrors(newErrors)
        return
      } else {
        setErrors({})
      }

      const formDataToSend = new FormData()
      formDataToSend.append('banner', localeBannerBlob!)
      if (localeOriginalBannerBlob) {
        formDataToSend.append('bannerOriginal', localeOriginalBannerBlob)
      }
      formDataToSend.append('name', data.name)
      formDataToSend.append('vndbId', data.vndbId)
      formDataToSend.append('vndbRelationId', data.vndbRelationId)
      formDataToSend.append('bangumiId', data.bangumiId)
      formDataToSend.append('steamId', data.steamId)
      formDataToSend.append('dlsiteCode', data.dlsiteCode)
      formDataToSend.append('dlsiteCircleName', data.dlsiteCircleName)
      formDataToSend.append('dlsiteCircleLink', data.dlsiteCircleLink)
      formDataToSend.append('vndbTags', JSON.stringify(data.vndbTags))
      formDataToSend.append(
        'vndbDevelopers',
        JSON.stringify(data.vndbDevelopers)
      )
      formDataToSend.append('bangumiTags', JSON.stringify(data.bangumiTags))
      formDataToSend.append(
        'bangumiDevelopers',
        JSON.stringify(data.bangumiDevelopers)
      )
      formDataToSend.append('steamTags', JSON.stringify(data.steamTags))
      formDataToSend.append(
        'steamDevelopers',
        JSON.stringify(data.steamDevelopers)
      )
      formDataToSend.append('steamAliases', JSON.stringify(data.steamAliases))
      formDataToSend.append('introduction', data.introduction)
      formDataToSend.append('alias', JSON.stringify(sanitizedAlias))
      formDataToSend.append('tag', JSON.stringify(sanitizedTag))
      formDataToSend.append('released', data.released)
      formDataToSend.append('contentLimit', data.contentLimit)

      toast('正在发布中 ... 这可能需要 10s 左右的时间, 这取决于您的网络环境')

      const res = await kunFetchFormData<
        KunResponse<{
          uniqueId: string
        }>
      >('/edit', formDataToSend)
      kunErrorHandler(res, async (value) => {
        // kunErrorHandler 的回调签名是同步的 (res: T) => void, 不会被 await, 外层
        // finally 会先于 await 之后的语句解禁按钮. 提示与跳转必须排在清理之前 ——
        // 否则 localforage 失败(如 Safari 无痕)会让两者双双跳过, 用户停在原页无任何
        // 反馈, 再点一次即重复创建
        toast.success('发布完成, 正在为您跳转到资源介绍页面')
        router.push(`/${value.uniqueId}`)
        resetData()
        await localforage.removeItem('kun-patch-banner')
        await localforage.removeItem('kun-patch-banner-original')
      })
    } catch (error) {
      errorReporter(error)
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  return (
    <Button
      color="primary"
      onPress={handleSubmit}
      className={cn('w-full mt-4', className)}
      isDisabled={creating}
      isLoading={creating}
    >
      提交
    </Button>
  )
}
