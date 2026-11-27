'use client'

import axios, { AxiosError } from 'axios'
import toast from 'react-hot-toast'
import { useEffect, useRef, useState } from 'react'
import { attachUpload } from './linkDraft'
import type {
  UseFormGetValues,
  UseFormSetValue,
  UseFormTrigger
} from 'react-hook-form'
import type { ResourceFormValues } from './linkDraft'
import type {
  KunUploadCompleteResponse,
  KunUploadInitResponse
} from '~/types/api/upload'

export interface ResourceUploadProgress {
  fileName: string
  bytes: number
  progress: number
}

interface UploadForm {
  getValues: UseFormGetValues<ResourceFormValues>
  setValue: UseFormSetValue<ResourceFormValues>
  trigger: UseFormTrigger<ResourceFormValues>
}

const KUN_FETCH_HEADERS = { 'X-Requested-With': 'kun-fetch' }

const withoutKey = <T>(record: Record<string, T>, key: string) => {
  const { [key]: _removed, ...rest } = record
  return rest
}

// 进行中的上传, 按链接草稿的 key 索引 (不按数组下标: 上传期间链接可以增删)。一条链接
// 同时至多一次上传; 传完的结果按 key 写回它的链接 (attachUpload), 那条链接已经不在或者
// 不再是对象存储就作废。链接被删、换了存储类型时由调用方 cancel, 表单卸载时全部中止
export const useResourceUploads = ({
  getValues,
  setValue,
  trigger
}: UploadForm) => {
  const [uploads, setUploads] = useState<
    Record<string, ResourceUploadProgress>
  >({})
  const controllers = useRef(new Map<string, AbortController>())

  useEffect(() => {
    const live = controllers.current
    return () => {
      for (const controller of live.values()) {
        controller.abort()
      }
      live.clear()
    }
  }, [])

  const cancel = (key: string) => {
    const controller = controllers.current.get(key)
    if (!controller) {
      return
    }
    controller.abort()
    controllers.current.delete(key)
    setUploads((prev) => withoutKey(prev, key))
  }

  // 把这条链接重新校验一遍: 新加的对象存储链接上传失败或被移除之后, 提示「请先上传资源文件」;
  // 传完之后清掉这条提示
  const validateLink = (key: string) => {
    const index = getValues('links').findIndex((link) => link.key === key)
    if (index !== -1) {
      void trigger(`links.${index}`)
    }
  }

  const start = async (key: string, file: File, captcha: string) => {
    if (controllers.current.has(key)) {
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    controllers.current.set(key, controller)
    setUploads((prev) => ({
      ...prev,
      [key]: { fileName: file.name, bytes: file.size, progress: 0 }
    }))

    try {
      const initRes = await axios.post<KunUploadInitResponse | string>(
        '/api/upload/init',
        { fileName: file.name, fileSize: file.size, captcha },
        { headers: KUN_FETCH_HEADERS, signal }
      )
      if (typeof initRes.data === 'string') {
        toast.error(initRes.data)
        return
      }

      const { uploadUrl, token } = initRes.data

      await axios.put(uploadUrl, file, {
        headers: { 'Content-Type': 'application/octet-stream' },
        signal,
        onUploadProgress: (progressEvent) => {
          const progress = Math.round(
            (progressEvent.loaded * 100) / (progressEvent.total || file.size)
          )
          setUploads((prev) =>
            prev[key] ? { ...prev, [key]: { ...prev[key], progress } } : prev
          )
        }
      })

      const completeRes = await axios.post<KunUploadCompleteResponse | string>(
        '/api/upload/complete',
        { token },
        { headers: KUN_FETCH_HEADERS, signal }
      )
      if (typeof completeRes.data === 'string') {
        toast.error(completeRes.data)
        return
      }

      const links = getValues('links')
      const next = attachUpload(links, key, {
        token: completeRes.data.fileToken,
        fileName: file.name,
        size: completeRes.data.fileSize
      })
      const index = next.findIndex((link) => link.key === key)
      if (next !== links && index !== -1) {
        setValue(`links.${index}`, next[index])
      }
    } catch (err) {
      // 被中止的上传不是失败: 链接已经不在了, 没有可提示的对象
      if (axios.isCancel(err)) {
        return
      }
      if (err instanceof AxiosError) {
        const status = err.response?.status
        const data = err.response?.data
        // eslint-disable-next-line no-console -- 客户端没有日志出口 (上报暂缓, T38 S5), 只留在浏览器控制台
        console.error('[upload] failed', {
          status,
          data,
          message: err.message,
          code: err.code
        })
        const rawDetail =
          typeof data === 'string' && data
            ? data
            : status
              ? `HTTP ${status}`
              : err.message
        const detail =
          rawDetail.length > 200 ? `${rawDetail.slice(0, 200)}…` : rawDetail
        toast.error(`上传失败: ${detail}`)
      } else {
        // eslint-disable-next-line no-console -- 客户端没有日志出口 (上报暂缓, T38 S5), 只留在浏览器控制台
        console.error('[upload] failed', err)
        toast.error('上传失败, 请重试')
      }
    } finally {
      // 被 cancel 的上传已经由 cancel 清掉自己的条目; 同一个 key 上可能已经开始了下一次上传
      if (controllers.current.get(key) === controller) {
        controllers.current.delete(key)
        setUploads((prev) => withoutKey(prev, key))
        validateLink(key)
      }
    }
  }

  return {
    uploads,
    uploading: Object.keys(uploads).length > 0,
    start,
    cancel
  }
}

export type ResourceUploads = ReturnType<typeof useResourceUploads>
