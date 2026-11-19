'use client'

import toast from 'react-hot-toast'
import { Upload } from 'lucide-react'
import { Button, Input } from '@heroui/react'
import { cn } from '~/utils/cn'
import { useState } from 'react'
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  OBJECT_STORAGE_MAX_FILE_SIZE_BYTES,
  OBJECT_STORAGE_MAX_FILE_SIZE_LABEL
} from '~/constants/resource'
import {
  toSafeObjectName,
  UNSAFE_OBJECT_NAME_ERROR
} from '~/utils/safeObjectName'

interface Props {
  onFileUpload: (file: File) => Promise<void>
}

const validateFileType = (file: File): boolean => {
  const fileExtension = file.name
    .slice(file.name.lastIndexOf('.'))
    .toLowerCase()
  return (
    ALLOWED_MIME_TYPES.includes(file.type) ||
    ALLOWED_EXTENSIONS.includes(fileExtension)
  )
}

const handleFileInput = (file: File | undefined) => {
  if (!file) {
    toast.error('未选择文件')
    return
  }

  if (!validateFileType(file)) {
    toast.error('文件类型不被支持，仅接受 .zip, .rar, .7z 格式')
    return
  }

  // 与服务端同一份命名策略: 洗不出名字的文件在人机验证之前就提示改名
  if (!toSafeObjectName(file.name)) {
    toast.error(UNSAFE_OBJECT_NAME_ERROR)
    return
  }

  const fileSizeMB = file.size / (1024 * 1024)
  if (fileSizeMB < 0.001) {
    toast.error('文件过小, 您的文件小于 0.001 MB')
    return
  }
  if (file.size >= OBJECT_STORAGE_MAX_FILE_SIZE_BYTES) {
    toast.error(
      `文件大小超出限制: ${fileSizeMB.toFixed(3)} MB, 必须小于 ${OBJECT_STORAGE_MAX_FILE_SIZE_LABEL}`
    )
    return
  }

  return file
}

export const FileDropZone = ({ onFileUpload }: Props) => {
  const [isDragging, setIsDragging] = useState(false)

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]

    const res = handleFileInput(file)

    if (res) {
      await onFileUpload(res)
    }
  }

  const handleClickUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    const res = handleFileInput(file)
    if (res) {
      await onFileUpload(res)
    }
  }

  return (
    <div
      className={cn(
        'border-2 border-dashed rounded-lg p-8 transition-colors',
        isDragging ? 'border-primary bg-primary/10' : 'border-default-300'
      )}
      onDrop={handleDrop}
      onDragOver={(e) => {
        e.preventDefault()
        setIsDragging(true)
      }}
      onDragLeave={() => setIsDragging(false)}
    >
      <div className="flex flex-col items-center justify-center gap-4">
        <Upload className="size-12 text-primary/60" />
        <p className="text-lg font-medium text-center">
          {isDragging ? '拖动文件到此处' : '拖动或点击以上传文件'}
        </p>
        <label>
          <Button color="primary" variant="flat" as="span">
            选择文件
          </Button>
          <Input
            type="file"
            className="hidden"
            onChange={handleClickUpload}
            accept="*/*"
          />
        </label>
        <p className="text-sm text-default-500">
          我们支持 .zip .7z .rar 压缩格式, 由于不会发生资源失效,
          请您根据自身需求设置解压密码
        </p>
      </div>
    </div>
  )
}
