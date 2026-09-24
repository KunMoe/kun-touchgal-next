'use client'

import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
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
import { updateTagSchema } from '~/validations/tag'
import { kunFetchPut } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import toast from 'react-hot-toast'
import type { TagDetail } from '~/types/api/tag'

type UpdateTagData = z.infer<typeof updateTagSchema>

interface Props {
  tag: TagDetail
  isOpen: boolean
  onClose: () => void
  onSuccess: (tag: TagDetail) => void
}

export const EditTagModal = ({ tag, isOpen, onClose, onSuccess }: Props) => {
  const [input, setInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const {
    register,
    formState: { errors },
    getValues,
    watch,
    setValue,
    reset
  } = useForm<UpdateTagData>({
    resolver: zodResolver(updateTagSchema),
    defaultValues: {
      tagId: tag.id,
      name: tag.name,
      introduction: tag.introduction || '',
      alias: tag.alias || []
    }
  })

  useEffect(() => {
    if (isOpen) {
      reset({
        tagId: tag.id,
        name: tag.name,
        introduction: tag.introduction || '',
        alias: tag.alias || []
      })
    }
  }, [isOpen, tag, reset])

  const addTag = () => {
    const lowerTag = input.trim().toLowerCase()
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

  const handleUpdateTag = async () => {
    if (!watch().alias) {
      return
    }
    addTag()

    setIsSubmitting(true)

    const res = await kunFetchPut<KunResponse<TagDetail>>('/tag', watch())

    kunErrorHandler(res, (value) => {
      reset()
      toast.success(
        '标签重新编辑成功, 由于缓存影响, 您的更改将在至多 30 秒后生效'
      )
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
          <ModalHeader>编辑标签</ModalHeader>
          <ModalBody>
            <div className="space-y-6">
              <Input
                {...register('name')}
                label="标签名称"
                placeholder="输入标签名称"
                isInvalid={!!errors.name}
                errorMessage={errors.name?.message}
              />

              <Textarea
                {...register('introduction')}
                label="标签简介"
                placeholder="输入标签简介"
                isInvalid={!!errors.introduction}
                errorMessage={errors.introduction?.message}
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
              onPress={handleUpdateTag}
            >
              保存
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  )
}
