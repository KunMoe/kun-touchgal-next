'use client'

import { useState } from 'react'
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip
} from '@heroui/react'
import { Video } from 'lucide-react'
import toast from 'react-hot-toast'
import { insertKunVideoCommand } from './videoPlugin'
import type { CmdKey } from '@milkdown/core'

interface VideoInsertButtonProps {
  call: <T>(command: CmdKey<T>, payload?: T | undefined) => boolean | undefined
}

export const VideoInsertButton = ({ call }: VideoInsertButtonProps) => {
  const [link, setLink] = useState('')
  const [isOpen, setIsOpen] = useState(false)

  const handleVideoInsert = () => {
    if (call(insertKunVideoCommand.key, { src: link }) === false) {
      toast.error('视频地址无效, 仅支持 http / https 链接')
      return
    }
    setLink('')
    setIsOpen(false)
  }

  return (
    <Popover
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      placement="bottom"
      offset={10}
    >
      <PopoverTrigger>
        <Button isIconOnly variant="light">
          <Tooltip content="插入视频" offset={16}>
            <Video className="size-6" />
          </Tooltip>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px]">
        {(titleProps) => (
          <div className="w-full px-1 py-2">
            <p className="font-bold text-small text-foreground" {...titleProps}>
              输入视频 URL 以插入
            </p>
            <div className="flex flex-col w-full gap-2 mt-2">
              <Input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                label="链接 URL"
                size="sm"
                variant="bordered"
              />
            </div>
            <Button
              variant="flat"
              color="primary"
              onPress={handleVideoInsert}
              className="w-full mt-2"
            >
              确定插入
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
