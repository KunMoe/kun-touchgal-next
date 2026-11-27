'use client'

import { Button } from '@heroui/button'
import {
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import toast from 'react-hot-toast'
import { kunFetchPut } from '~/utils/kunFetch'
import { ResourceLinksInput } from '../publish/ResourceLinksInput'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { ResourceDetailsForm } from '../publish/ResourceDetailsForm'
import { ResourceSectionSelect } from '../publish/ResourceSectionSelect'
import { fromResource, toRequest } from '../form/linkDraft'
import { resourceFormResolver } from '../form/resolver'
import { useResourceUploads } from '../form/useResourceUploads'
import { RESOURCE_SECTION_TYPE_MAP } from '~/constants/resource'
import type { PatchResource } from '~/types/api/patch'
import type { ResourceFormValues } from '../form/linkDraft'
import { contentPhase } from '~/constants/contentStatus'

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

  const {
    control,
    reset,
    getValues,
    setValue,
    trigger,
    watch,
    formState: { errors }
  } = useForm<ResourceFormValues>({
    resolver: resourceFormResolver,
    defaultValues: fromResource(resource)
  })
  const uploads = useResourceUploads({ getValues, setValue, trigger })
  const uploadingResource = uploads.uploading

  const handleUpdateResource = async () => {
    setEditing(true)
    const res = await kunFetchPut<KunResponse<PatchResource>>(
      `/${type}/resource`,
      { resourceId: resource.id, ...toRequest(getValues()) }
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
            getValues={getValues}
            setValue={setValue}
            trigger={trigger}
            watch={watch}
            section={watch().section}
            uploads={uploads}
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
