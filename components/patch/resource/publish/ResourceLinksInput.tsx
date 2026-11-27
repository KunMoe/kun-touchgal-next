'use client'

import { useEffect } from 'react'
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
import {
  discardUpload,
  emptyLink,
  linkView,
  releasesStoredFile,
  switchStorage
} from '../form/linkDraft'
import type { KunLinkStorage } from '~/constants/permission'
import type { ResourceUploads } from '../form/useResourceUploads'
import type {
  ControlType,
  ErrorType,
  GetValuesType,
  SetValueType,
  TriggerType,
  WatchType
} from '../share'

interface ResourceLinksInputProps {
  control: ControlType
  errors: ErrorType
  getValues: GetValuesType
  setValue: SetValueType
  trigger: TriggerType
  watch: WatchType
  section: string
  uploads: ResourceUploads
}

// 一条链接上可能出现的校验错误, 按请求体的字段名 (见 form/resolver.ts)
type LinkErrors = Partial<
  Record<
    'storage' | 'content' | 'size' | 'code' | 'password' | 'uploadToken',
    { message?: string }
  >
>

const isLinkStorage = (value: string): value is KunLinkStorage =>
  KUN_LINK_STORAGES.some((storage) => storage === value)

export const ResourceLinksInput = ({
  control,
  errors,
  getValues,
  setValue,
  trigger,
  watch,
  section,
  uploads
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
      append(emptyLink(defaultStorage))
    }
  }, [append, fields.length, defaultStorage])

  // 上传只在它的对象存储链接还在时才算数: 链接被删、换了存储类型、整组链接被换掉
  // (切换分区) 之后, 还在传的那一次就地中止。每次渲染之后都核对, 不列依赖: 表单值是原地
  // 改写的 (换存储类型之后 watch('links') 给的还是同一个数组), 拿它当依赖判断不出变化
  const { uploads: activeUploads, cancel: cancelUpload } = uploads
  useEffect(() => {
    for (const key of Object.keys(activeUploads)) {
      if (!links.some((link) => link.key === key && link.storage === 's3')) {
        cancelUpload(key)
      }
    }
  })

  // 取大小是异步的: 结果按 key 找回链接, 不按发起时的下标
  const handleFetchTouchGalSize = async (key: string) => {
    const currentLink = links.find((link) => link.key === key)
    if (
      !currentLink ||
      currentLink.storage !== 'touchgal' ||
      !currentLink.content ||
      !!currentLink.size ||
      !currentLink.content.includes('pan.touchgal.net/')
    ) {
      return
    }

    toast('正在尝试从 TouchGal Alist 获取文件大小')
    const data = await fetchLinkData(currentLink.content)
    if (data && data.code === 0) {
      let sizeInGB
      if (data.data.source.size > 0) {
        sizeInGB = (data.data.source.size / 1024 ** 3).toFixed(3)
      } else {
        const listSize = await fetchListData(data.data.key)
        sizeInGB = listSize ? (listSize / 1024 ** 3).toFixed(3) : ''
      }
      const index = getValues('links').findIndex(
        (link) => link.key === key && link.storage === 'touchgal'
      )
      if (sizeInGB && index !== -1) {
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
          onPress={() => append(emptyLink(defaultStorage))}
        >
          添加链接
        </Button>
      </div>

      {fields.map((field, index) => {
        const link = links[index]
        if (!link) {
          return null
        }
        const view = linkView(link)
        const linkErrors: LinkErrors | undefined = errors.links?.[index]

        return (
          <Card key={link.key} className="border border-default-200">
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

              <Select
                label="存储类型"
                selectedKeys={[link.storage]}
                onSelectionChange={(key) => {
                  const value = Array.from(key).join('')
                  if (isLinkStorage(value)) {
                    setValue(`links.${index}`, switchStorage(link, value))
                  }
                }}
                disabledKeys={KUN_LINK_STORAGES.filter(
                  (storage) => !allowedStorages.includes(storage)
                )}
                isInvalid={!!linkErrors?.storage}
                errorMessage={linkErrors?.storage?.message}
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

              {releasesStoredFile(link) && (
                <p className="text-sm text-warning-600">
                  这条链接原来上传的文件将在保存后删除
                </p>
              )}

              {link.storage === 's3' && (
                <FileUploadContainer
                  progress={activeUploads[link.key]}
                  uploaded={link.upload}
                  onUpload={(file, captcha) => {
                    void uploads.start(link.key, file, captcha)
                  }}
                  onRemove={() => {
                    setValue(`links.${index}`, discardUpload(link))
                    void trigger(`links.${index}`)
                  }}
                  errorMessage={linkErrors?.uploadToken?.message}
                />
              )}

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {link.storage === 's3' ? (
                  <>
                    <Input
                      isReadOnly
                      label="资源链接"
                      placeholder="上传文件后自动生成链接"
                      value={
                        view === 's3-kept' ? (link.origin?.content ?? '') : ''
                      }
                    />
                    <Input
                      isReadOnly
                      label="大小"
                      placeholder="上传文件后自动填写"
                      value={
                        link.upload?.size ??
                        (view === 's3-kept' ? (link.origin?.size ?? '') : '')
                      }
                    />
                  </>
                ) : (
                  <>
                    <Controller
                      name={`links.${index}.content`}
                      control={control}
                      render={({ field }) => (
                        <Input
                          {...field}
                          isRequired
                          label="资源链接"
                          placeholder={`请输入${SUPPORTED_RESOURCE_LINK_MAP[link.storage]}`}
                          isInvalid={!!linkErrors?.content}
                          errorMessage={linkErrors?.content?.message}
                          onBlur={() => {
                            field.onBlur()
                            void handleFetchTouchGalSize(link.key)
                          }}
                          onPaste={(e) => {
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
                          isInvalid={!!linkErrors?.size}
                          errorMessage={linkErrors?.size?.message}
                        />
                      )}
                    />
                  </>
                )}
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
                      isInvalid={!!linkErrors?.code}
                      errorMessage={linkErrors?.code?.message}
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
                      isInvalid={!!linkErrors?.password}
                      errorMessage={linkErrors?.password?.message}
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
