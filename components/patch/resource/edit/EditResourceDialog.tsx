'use client'

import * as z from 'zod'
import { Button } from '@heroui/button'
import {
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import toast from 'react-hot-toast'
import { kunFetchPut } from '~/utils/kunFetch'
import { patchResourceCreateSchema } from '~/validations/patch'
import { ResourceLinksInput } from '../publish/ResourceLinksInput'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { ResourceDetailsForm } from '../publish/ResourceDetailsForm'
import { ResourceSectionSelect } from '../publish/ResourceSectionSelect'
import {
  RESOURCE_SECTION_TYPE_MAP,
  SUPPORTED_PLATFORM,
  SUPPORTED_TYPE
} from '~/constants/resource'
import type { PatchResource } from '~/types/api/patch'

type EditResourceFormData = z.infer<typeof patchResourceCreateSchema>

interface EditResourceDialogProps {
  resource: PatchResource
  onClose: () => void
  onSuccess: (resource: PatchResource) => void
  type?: 'patch' | 'admin'
}

export const EditResourceDialog = ({
  resource,
  onClose,
  onSuccess,
  type = 'patch'
}: EditResourceDialogProps) => {
  const [editing, setEditing] = useState(false)
  const [uploadingResource, setUploadingResource] = useState(false)

  // 未迁移的历史资源可能残留旧词表值 (type 的 pc/chinese, platform 的 android 等),
  // 这些值不在 Select 选项内, 用户无法在 UI 里取消, 却会随提交触发校验失败.
  // 分类迁移全部落库后, 下方 type/platform 两处 filter 即恒等, 可一并删除
  const allowedTypes =
    RESOURCE_SECTION_TYPE_MAP[resource.section] ?? SUPPORTED_TYPE

  const {
    control,
    reset,
    setValue,
    watch,
    formState: { errors }
  } = useForm<EditResourceFormData>({
    resolver: zodResolver(patchResourceCreateSchema),
    defaultValues: {
      ...resource,
      type: resource.type.filter((t) => allowedTypes.includes(t)),
      platform: resource.platform.filter((p) => SUPPORTED_PLATFORM.includes(p)),
      // 兼容旧缓存数据缺字段: 保持受控输入
      emulatorType: resource.emulatorType ?? [],
      modelName: resource.modelName ?? ''
    }
  })

  const handleUpdateResource = async () => {
    setEditing(true)
    const res = await kunFetchPut<KunResponse<PatchResource>>(
      `/${type}/resource`,
      { resourceId: resource.id, ...watch() }
    )
    kunErrorHandler(res, (value) => {
      reset()
      onSuccess(value)
      toast.success('资源更新成功')
    })
    setEditing(false)
  }

  return (
    <ModalContent>
      <ModalHeader className="flex-col space-y-2">
        <h3 className="text-lg">更改资源链接</h3>
        <p className="text-sm font-medium text-default-500">
          若您想要更改您的对象存储链接, 您现在可以直接上传新文件,
          系统会自动更新云端文件, 无需删除后重新发布
        </p>
      </ModalHeader>

      <ModalBody>
        <form className="space-y-6">
          <ResourceSectionSelect
            errors={errors}
            section={watch().section}
            setSection={(content) => {
              setValue('section', content)
              setValue(
                'type',
                watch().type.filter((t) =>
                  RESOURCE_SECTION_TYPE_MAP[content]?.includes(t)
                )
              )
            }}
          />

          <ResourceLinksInput
            control={control}
            errors={errors}
            setValue={setValue}
            watch={watch}
            section={watch().section}
            setUploadingResource={setUploadingResource}
          />
          <ResourceDetailsForm
            control={control}
            errors={errors}
            section={watch().section}
          />
        </form>
      </ModalBody>

      <ModalFooter>
        <Button color="danger" variant="light" onPress={onClose}>
          取消
        </Button>
        <Button
          color="primary"
          disabled={editing || uploadingResource}
          isLoading={editing || uploadingResource}
          onPress={handleUpdateResource}
        >
          {editing
            ? '更新中...'
            : uploadingResource
              ? '正在上传资源中...'
              : '保存'}
        </Button>
      </ModalFooter>
    </ModalContent>
  )
}
