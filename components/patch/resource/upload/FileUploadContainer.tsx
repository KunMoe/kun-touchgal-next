'use client'

import toast from 'react-hot-toast'
import { useState } from 'react'
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
import { formatResourceSize } from '~/utils/resourceSize'
import type { UploadedFile } from '../form/linkDraft'
import type { ResourceUploadProgress } from '../form/useResourceUploads'
import type { FileStatus } from '../share'

interface Props {
  // 这条链接上进行中的上传 (useResourceUploads); 没有在传就是 undefined
  progress: ResourceUploadProgress | undefined
  // 已经传完、挂在这条链接上的文件 (链接草稿里的 upload)
  uploaded: UploadedFile | null
  onUpload: (file: File, captcha: string) => void
  onRemove: () => void
  errorMessage?: string
}

export const FileUploadContainer = ({
  progress,
  uploaded,
  onUpload,
  onRemove,
  errorMessage
}: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const canPublish = useUserStore((state) => canPublishResource(state.user))
  const skipCaptcha = useUserStore((state) =>
    can(state.user, 'upload.skipCaptcha')
  )
  // 选好了、还在等人机验证的文件
  const [pendingFile, setPendingFile] = useState<File | null>(null)

  const handleCaptchaSuccess = (code: string) => {
    onClose()

    const file = pendingFile
    setPendingFile(null)
    if (!file) {
      toast.error('未找到资源文件, 请重试')
      return
    }
    onUpload(file, code)
  }

  const handleFileUpload = async (file: File) => {
    if (!file) {
      return
    }

    if (file.size >= OBJECT_STORAGE_MAX_FILE_SIZE_BYTES) {
      toast.error(
        `文件大小超出限制: ${formatResourceSize(file.size)}, 必须小于 ${OBJECT_STORAGE_MAX_FILE_SIZE_LABEL}`
      )
      return
    }

    if (!canPublish) {
      toast.error(POINT_GATE_MESSAGE.publishResource)
      return
    }

    if (!skipCaptcha) {
      setPendingFile(file)
      onOpen()
    } else {
      onUpload(file, '')
    }
  }

  const handleCaptureClose = () => {
    onClose()
    setPendingFile(null)
  }

  const fileData: FileStatus | null = progress
    ? {
        fileName: progress.fileName,
        size: formatResourceSize(progress.bytes),
        progress: progress.progress,
        done: false
      }
    : pendingFile
      ? {
          fileName: pendingFile.name,
          size: formatResourceSize(pendingFile.size),
          progress: 0,
          done: false
        }
      : uploaded
        ? {
            fileName: uploaded.fileName,
            size: uploaded.size,
            progress: 100,
            done: true
          }
        : null

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
        <FileUploadCard fileData={fileData} onRemove={onRemove} />
      )}

      {errorMessage && !fileData && (
        <p className="text-tiny text-danger">{errorMessage}</p>
      )}
    </div>
  )
}
