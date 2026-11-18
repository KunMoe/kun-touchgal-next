'use client'

import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { Controller, useFieldArray } from 'react-hook-form'
import { Input } from '@heroui/input'
import { Button } from '@heroui/button'
import { Card, CardBody } from '@heroui/card'
import { Chip } from '@heroui/chip'
import { Select, SelectItem } from '@heroui/select'
import { Divider } from '@heroui/divider'
import { Plus, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useShallow } from 'zustand/react/shallow'
import { SUPPORTED_RESOURCE_LINK_MAP, storageTypes } from '~/constants/resource'
import {
  KUN_LINK_STORAGES,
  allowedLinkStorages,
  defaultLinkStorage
} from '~/constants/permission'
import { fetchLinkData, fetchListData } from './fetchAlistSize'
import { parseResourceLink } from '~/utils/resourceLink'
import { FileUploadContainer } from '../upload/FileUploadContainer'
import { useUserStore } from '~/store/userStore'
import type { ControlType, ErrorType, SetValueType, WatchType } from '../share'

interface ResourceLinksInputProps {
  control: ControlType
  errors: ErrorType
  setValue: SetValueType
  watch: WatchType
  section: string
  setUploadingResource: Dispatch<SetStateAction<boolean>>
}

const createEmptyLink = (storage: string) => ({
  storage,
  hash: '',
  content: '',
  size: '',
  code: '',
  password: ''
})

export const ResourceLinksInput = ({
  control,
  errors,
  setValue,
  watch,
  section,
  setUploadingResource
}: ResourceLinksInputProps) => {
  // 这里只决定显隐与置灰; 执法在服务端, 两边调的是 constants/permission 里的同一组函数
  const subject = useUserStore(
    useShallow((state) => ({ uid: state.user.uid, role: state.user.role }))
  )
  const allowedStorages = allowedLinkStorages(subject, section)
  const defaultStorage = defaultLinkStorage(subject, section)
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'links'
  })
  const links = watch('links') || []

  useEffect(() => {
    if (!fields.length) {
      append(createEmptyLink(defaultStorage))
    }
  }, [append, fields.length, defaultStorage])

  const handleFetchTouchGalSize = async (content: string, index: number) => {
    const currentLink = links[index]
    if (
      !currentLink ||
      currentLink.storage !== 'touchgal' ||
      !content ||
      !!currentLink.size ||
      !content.includes('pan.touchgal.net/')
    ) {
      return
    }

    toast('正在尝试从 TouchGal Alist 获取文件大小')
    const data = await fetchLinkData(content)
    if (data && data.code === 0) {
      let sizeInGB
      if (data.data.source.size > 0) {
        sizeInGB = (data.data.source.size / 1024 ** 3).toFixed(3)
      } else {
        const listSize = await fetchListData(data.data.key)
        sizeInGB = listSize ? (listSize / 1024 ** 3).toFixed(3) : ''
      }
      if (sizeInGB) {
        setValue(`links.${index}.size`, `${sizeInGB} GB`, {
          shouldValidate: true
        })
        toast.success('获取文件大小成功')
      }
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h3 className="text-lg font-medium">资源链接</h3>
          <p className="text-sm text-default-500">
            每条资源链接都拥有独立的存储类型、大小、提取码和解压码
          </p>
        </div>

        <Button
          variant="flat"
          startContent={<Plus className="size-4" />}
          onPress={() => append(createEmptyLink(defaultStorage))}
        >
          添加链接
        </Button>
      </div>

      {fields.map((field, index) => {
        const currentLink = links[index]
        const currentStorage = currentLink?.storage || defaultStorage

        return (
          <Card key={field.id} className="border border-default-200">
            <CardBody className="space-y-4">
              <div className="flex items-center justify-between">
                <Chip color="primary" variant="flat">
                  链接 #{index + 1}
                </Chip>

                <Button
                  isIconOnly
                  variant="light"
                  color="danger"
                  isDisabled={fields.length === 1}
                  onPress={() => remove(index)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>

              <Controller
                name={`links.${index}.storage`}
                control={control}
                render={({ field }) => (
                  <Select
                    label="存储类型"
                    selectedKeys={field.value ? [field.value] : []}
                    onSelectionChange={(key) => {
                      const value = Array.from(key).join('')
                      field.onChange(value)
                      if (value !== 's3') {
                        setValue(`links.${index}.hash`, '', {
                          shouldValidate: true
                        })
                      } else {
                        setValue(`links.${index}.content`, '', {
                          shouldValidate: true
                        })
                      }
                    }}
                    disabledKeys={KUN_LINK_STORAGES.filter(
                      (storage) => !allowedStorages.includes(storage)
                    )}
                    isInvalid={!!errors.links?.[index]?.storage}
                    errorMessage={errors.links?.[index]?.storage?.message}
                  >
                    {storageTypes.map((type) => (
                      <SelectItem key={type.value} textValue={type.label}>
                        <div className="flex flex-col">
                          <span className="text">{type.label}</span>
                          <span className="text-small text-default-500">
                            {type.description}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </Select>
                )}
              />

              {currentStorage === 's3' && (
                <FileUploadContainer
                  onSuccess={(storage, hash, content, size) => {
                    setValue(`links.${index}.storage`, storage, {
                      shouldValidate: true
                    })
                    setValue(`links.${index}.hash`, hash, {
                      shouldValidate: true
                    })
                    setValue(`links.${index}.content`, content, {
                      shouldValidate: true
                    })
                    setValue(`links.${index}.size`, size, {
                      shouldValidate: true
                    })
                  }}
                  handleRemoveFile={() => {
                    setValue(`links.${index}.hash`, '', {
                      shouldValidate: true
                    })
                    setValue(`links.${index}.content`, '', {
                      shouldValidate: true
                    })
                    setValue(`links.${index}.size`, '', {
                      shouldValidate: true
                    })
                  }}
                  setUploadingResource={setUploadingResource}
                />
              )}

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Controller
                  name={`links.${index}.content`}
                  control={control}
                  render={({ field }) => (
                    <Input
                      {...field}
                      isRequired={currentStorage !== 's3'}
                      label="资源链接"
                      placeholder={
                        currentStorage === 's3'
                          ? '上传文件后自动生成链接'
                          : `请输入${SUPPORTED_RESOURCE_LINK_MAP[currentStorage]}`
                      }
                      isReadOnly={currentStorage === 's3'}
                      isInvalid={!!errors.links?.[index]?.content}
                      errorMessage={errors.links?.[index]?.content?.message}
                      onBlur={() => {
                        field.onBlur()
                        handleFetchTouchGalSize(field.value, index)
                      }}
                      onPaste={(e) => {
                        if (currentStorage === 's3') {
                          return
                        }
                        const pasted = e.clipboardData.getData('text')
                        if (!pasted.trim()) {
                          return
                        }
                        const { url, code } = parseResourceLink(pasted)
                        if (url !== pasted.trim() || code) {
                          e.preventDefault()
                          field.onChange(url)
                          if (code) {
                            setValue(`links.${index}.code`, code, {
                              shouldValidate: true
                            })
                            toast.success('已自动识别并填入提取码')
                          }
                        }
                      }}
                    />
                  )}
                />

                <Controller
                  name={`links.${index}.size`}
                  control={control}
                  render={({ field }) => (
                    <Input
                      {...field}
                      isRequired
                      label="大小 (MB 或 GB)"
                      placeholder="请输入资源大小，例如 1.024 GB"
                      isInvalid={!!errors.links?.[index]?.size}
                      errorMessage={errors.links?.[index]?.size?.message}
                    />
                  )}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Controller
                  name={`links.${index}.code`}
                  control={control}
                  render={({ field }) => (
                    <Input
                      {...field}
                      label="提取码"
                      placeholder="如果资源需要提取码，请填写"
                      isInvalid={!!errors.links?.[index]?.code}
                      errorMessage={errors.links?.[index]?.code?.message}
                    />
                  )}
                />

                <Controller
                  name={`links.${index}.password`}
                  control={control}
                  render={({ field }) => (
                    <Input
                      {...field}
                      label="解压码"
                      placeholder="如果资源需要解压码，请填写"
                      isInvalid={!!errors.links?.[index]?.password}
                      errorMessage={errors.links?.[index]?.password?.message}
                    />
                  )}
                />
              </div>

              {index !== fields.length - 1 && <Divider />}
            </CardBody>
          </Card>
        )
      })}
    </div>
  )
}
