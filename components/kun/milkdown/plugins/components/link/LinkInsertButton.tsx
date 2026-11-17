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
import { Link2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { insertKunLinkCommand } from './linkPlugin'
import type { CmdKey } from '@milkdown/core'

interface LinkInsertButtonProps {
  call: <T>(command: CmdKey<T>, payload?: T | undefined) => boolean | undefined
}

export const LinkInsertButton = ({ call }: LinkInsertButtonProps) => {
  const [link, setLink] = useState('')
  const [text, setText] = useState('')
  const [isOpen, setIsOpen] = useState(false)

  const handleLinkInsert = () => {
    if (call(insertKunLinkCommand.key, { href: link, text }) === false) {
      toast.error('链接地址无效或协议不受支持')
      return
    }
    setLink('')
    setText('')
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
          <Tooltip content="插入链接" offset={16}>
            <Link2 className="size-6" />
          </Tooltip>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px]">
        {(titleProps) => (
          <div className="w-full px-1 py-2">
            <p className="font-bold text-small text-foreground" {...titleProps}>
              输入链接信息
            </p>
            <div className="flex flex-col w-full gap-2 mt-2">
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                label="链接文本"
                placeholder="显示的文本"
                size="sm"
                variant="bordered"
              />
              <Input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                label="链接 URL"
                placeholder="https://example.com"
                size="sm"
                variant="bordered"
              />
            </div>
            <Button
              variant="flat"
              color="primary"
              onPress={handleLinkInsert}
              className="w-full mt-2"
              isDisabled={!link || !text}
            >
              确定插入
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
