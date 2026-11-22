'use client'

import { Button } from '@heroui/react'

interface Props {
  message: string
  onRetry: () => void
}

// 列表取数失败时占住列表的位置 (不画成空态), 重试取当前查询
export const KunListError = ({ message, onRetry }: Props) => (
  <div className="space-y-3 py-12 text-center">
    <p className="text-danger">{message}</p>
    <Button variant="flat" onPress={onRetry}>
      重试
    </Button>
  </div>
)
