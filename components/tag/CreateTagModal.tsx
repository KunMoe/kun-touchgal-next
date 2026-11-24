'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import type { z } from 'zod'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/modal'
import { Button } from '@heroui/button'
import { Input, Textarea } from '@heroui/input'
import { Chip } from '@heroui/chip'
import { Plus } from 'lucide-react'
import type { createTagSchema } from '~/validations/tag'
import { kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { aliasKey } from '~/utils/term/normalize'
import toast from 'react-hot-toast'
import type { Tag } from '~/types/api/tag'

type FormData = z.infer<typeof createTagSchema>

interface Props {
  isOpen: boolean
  onClose: () => void
  onSuccess: (tag: Tag) => void
}

export const CreateTagModal = ({ isOpen, onClose, onSuccess }: Props) => {
  const [input, setInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { register, getValues, watch, setValue, reset } = useForm<FormData>({
    defaultValues: {
      name: '',
      introduction: '',
      alias: []
    }
  })

  const addTag = () => {
    const lowerTag = aliasKey(input)
    if (!lowerTag) {
      return
    }

    const prevAlias = getValues().alias
    if (!prevAlias?.includes(lowerTag)) {
      setValue('alias', [...prevAlias, lowerTag])
      setInput('')
    } else {
      toast.error('标签已存在, 请更换')
    }
  }

  const handleRemoveAlias = (index: number) => {
    const prevAlias = getValues().alias
    setValue(
      'alias',
      prevAlias?.filter((_, i) => i !== index)
    )
  }

  const handleCreateTag = async () => {
    addTag()
    setIsSubmitting(true)
    const res = await kunFetchPost<KunResponse<Tag>>('/tag', watch())
    kunErrorHandler(res, (value) => {
      reset()
      onSuccess(value)
    })
    setIsSubmitting(false)
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="2xl">
      <ModalContent>
        <form>
          <ModalHeader>创建新标签</ModalHeader>
          <ModalBody>
            <div className="space-y-6">
              <Input
                {...register('name')}
                label="标签名称"
                placeholder="输入标签名称"
              />

              <Textarea
                {...register('introduction')}
                label="标签简介"
                placeholder="输入标签简介"
              />

              <div className="space-y-2">
                <div className="flex space-x-2">
                  <Input
                    labelPlacement="outside"
                    label="别名"
                    placeholder="可以按回车添加别名"
                    value={input}
                    onChange={(e) => {
                      e.preventDefault()
                      setInput(e.target.value)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        // 输入法选字的回车不算提交, Safari 只能靠 keyCode 229 识别
                        if (e.nativeEvent.isComposing || e.keyCode === 229)
                          return
                        addTag()
                      }
                    }}
                  />
                  <Button
                    color="primary"
                    onPress={addTag}
                    className="self-end"
                    isIconOnly
                  >
                    <Plus size={20} />
                  </Button>
                </div>

                <div className="flex flex-wrap gap-2">
                  {watch().alias?.map((alias, index) => (
                    <Chip
                      key={index}
                      onClose={() => handleRemoveAlias(index)}
                      variant="flat"
                    >
                      {alias}
                    </Chip>
                  ))}
                </div>
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={handleClose}>
              取消
            </Button>
            <Button
              color="primary"
              isDisabled={isSubmitting}
              isLoading={isSubmitting}
              onPress={handleCreateTag}
            >
              创建
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  )
}
