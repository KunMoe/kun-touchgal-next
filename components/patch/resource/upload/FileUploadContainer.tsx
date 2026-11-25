'use client'

import axios, { AxiosError } from 'axios'
import toast from 'react-hot-toast'
import { Dispatch, SetStateAction, useState } from 'react'
import { FileDropZone } from './FileDropZone'
import { FileUploadCard } from './FileUploadCard'
import { KunCaptchaModal } from '~/components/kun/auth/CaptchaModal'
import { useDisclosure } from '@heroui/modal'
import { useUserStore } from '~/store/userStore'
import { can, canPublishResource } from '~/constants/permission'
import { POINT_GATE_MESSAGE } from '~/constants/points'
import {
  OBJECT_STORAGE_MAX_FILE_SIZE_BYTES,
  OBJECT_STORAGE_MAX_FILE_SIZE_LABEL
} from '~/constants/resource'
import type {
  KunUploadCompleteResponse,
  KunUploadInitResponse
} from '~/types/api/upload'
import type { FileStatus } from '../share'

interface Props {
  onSuccess: (
    storage: string,
    hash: string,
    content: string,
    size: string
  ) => void
  handleRemoveFile: () => void
  setUploadingResource: Dispatch<SetStateAction<boolean>>
}

const KUN_FETCH_HEADERS = { 'X-Requested-With': 'kun-fetch' }

export const FileUploadContainer = ({
  onSuccess,
  handleRemoveFile,
  setUploadingResource
}: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const canPublish = useUserStore((state) => canPublishResource(state.user))
  const skipCaptcha = useUserStore((state) =>
    can(state.user, 'upload.skipCaptcha')
  )
  const [fileData, setFileData] = useState<FileStatus | null>(null)

  const handleCaptchaSuccess = async (
    code: string,
    fileToUpload?: File | null
  ) => {
    onClose()

    const file = fileToUpload || fileData?.file
    if (!file) {
      toast.error('未找到资源文件, 请重试')
      return
    }

    setUploadingResource(true)
    setFileData({ file, progress: 0 })

    try {
      const initRes = await axios.post<KunUploadInitResponse | string>(
        '/api/upload/init',
        {
          fileName: file.name,
          fileSize: file.size,
          captcha: code
        },
        { headers: KUN_FETCH_HEADERS }
      )
      if (typeof initRes.data === 'string') {
        toast.error(initRes.data)
        setFileData(null)
        handleRemoveFile()
        return
      }

      const { uploadUrl, token } = initRes.data

      await axios.put(uploadUrl, file, {
        headers: { 'Content-Type': 'application/octet-stream' },
        onUploadProgress: (progressEvent) => {
          const progress = Math.round(
            (progressEvent.loaded * 100) / (progressEvent.total || file.size)
          )
          setFileData((prev) => (prev ? { ...prev, progress } : null))
        }
      })

      const completeRes = await axios.post<KunUploadCompleteResponse | string>(
        '/api/upload/complete',
        { token },
        { headers: KUN_FETCH_HEADERS }
      )
      if (typeof completeRes.data === 'string') {
        toast.error(completeRes.data)
        setFileData(null)
        handleRemoveFile()
        return
      }

      const { fileToken, fileSize, filetype } = completeRes.data
      setFileData((prev) =>
        prev ? { ...prev, hash: fileToken, filetype } : null
      )
      onSuccess(filetype, fileToken, '', fileSize)
    } catch (err) {
      if (err instanceof AxiosError) {
        const status = err.response?.status
        const data = err.response?.data
        // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
        console.error('[upload] failed', err)
        toast.error('上传失败, 请重试')
      }
      setFileData(null)
      handleRemoveFile()
    } finally {
      setUploadingResource(false)
    }
  }

  const handleFileUpload = async (file: File) => {
    if (!file) {
      return
    }

    const fileSizeMB = file.size / (1024 * 1024)
    if (file.size >= OBJECT_STORAGE_MAX_FILE_SIZE_BYTES) {
      toast.error(
        `文件大小超出限制: ${fileSizeMB.toFixed(3)} MB, 必须小于 ${OBJECT_STORAGE_MAX_FILE_SIZE_LABEL}`
      )
      return
    }

    if (!canPublish) {
      toast.error(POINT_GATE_MESSAGE.publishResource)
      return
    }

    setFileData({ file, progress: 0 })

    if (!skipCaptcha) {
      onOpen()
    } else {
      await handleCaptchaSuccess('', file)
    }
  }

  const removeFile = () => {
    setFileData(null)
    handleRemoveFile()
  }

  const handleCaptureClose = () => {
    onClose()
    removeFile()
  }

  return (
    <div className="space-y-2">
      <h3 className="text-lg font-medium">上传资源</h3>
      <p className="text-sm text-default-500">
        您的文件在上传后将会被去除特殊字符, 仅保留下划线 ( _ ) 或连字符 ( - ),
        以及后缀
      </p>

      <KunCaptchaModal
        isOpen={isOpen}
        onClose={handleCaptureClose}
        onSuccess={handleCaptchaSuccess}
      />

      {!fileData ? (
        <FileDropZone onFileUpload={handleFileUpload} />
      ) : (
        <FileUploadCard fileData={fileData} onRemove={removeFile} />
      )}
    </div>
  )
}
