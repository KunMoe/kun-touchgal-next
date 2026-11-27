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
import { RESOURCE_SECTION_TYPE_MAP } from '~/constants/resource'
import type { PatchResource } from '~/types/api/patch'
import { contentPhase } from '~/constants/contentStatus'

type EditResourceFormData = z.infer<typeof patchResourceCreateSchema>

// 按阶段穷举: 编辑被预审拦下时资源转为待审核、别人暂时看不到, 不能只说更新成功 (P26-04)
const editSuccessMessage = (status: number) => {
  const phase = contentPhase('resource', status)
  switch (phase) {
    case 'pending':
      return '资源已更新，正在审核中，通过前仅你和管理员可见'
    case 'public':
    case 'awaitingApproval':
    case 'hidden':
      return '资源更新成功'
    default:
      return phase satisfies never
  }
}

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
      toast.success(editSuccessMessage(value.status))
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
