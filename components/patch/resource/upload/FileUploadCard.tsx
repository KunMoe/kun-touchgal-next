import { Button, Card, Progress } from '@heroui/react'
import { File as FileIcon } from 'lucide-react'
import { toSafeObjectName } from '~/utils/safeObjectName'
import type { FileStatus } from '../share'

interface Props {
  fileData: FileStatus
  onRemove: () => void
}

export const FileUploadCard = ({ fileData, onRemove }: Props) => {
  const fileName = (
    toSafeObjectName(fileData.fileName) ?? fileData.fileName
  ).slice(0, 20)

  return (
    <Card className="p-4 mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileIcon className="size-6 text-primary/60" />
          <div className="flex-1">
            <p className="font-medium truncate">{fileName}</p>
            <p className="text-sm text-default-500">{fileData.size}</p>
          </div>
        </div>
        {fileData.done ? (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-sm text-default-500">文件上传成功</span>
            <Button color="danger" variant="flat" onPress={onRemove}>
              移除
            </Button>
          </div>
        ) : fileData.error ? (
          <div className="flex items-center gap-2">
            <p className="text-sm text-danger-500">{fileData.error}</p>
            <Button color="danger" variant="light" onPress={onRemove}>
              移除
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-default-500">正在上传中...</p>
            <Progress
              value={fileData.progress}
              className="w-24"
              size="sm"
              color="primary"
              aria-label={`上传进度: ${fileData.progress}%`}
            />
          </div>
        )}
      </div>
    </Card>
  )
}
