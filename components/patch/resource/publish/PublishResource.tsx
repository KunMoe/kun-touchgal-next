'use client'

import * as z from 'zod'
import { useRef, useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button } from '@heroui/button'
import { Link } from '@heroui/link'
import {
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Progress
} from '@heroui/react'
import toast from 'react-hot-toast'
import { kunFetchPost } from '~/utils/kunFetch'
import { patchResourceCreateSchema } from '~/validations/patch'
import { ResourceLinksInput } from './ResourceLinksInput'
import { ResourceDetailsForm } from './ResourceDetailsForm'
import { ResourceSectionSelect } from './ResourceSectionSelect'
import { Upload, Gamepad2, Puzzle } from 'lucide-react'
import {
  RESOURCE_SECTION_MAP,
  RESOURCE_SECTION_TYPE_MAP,
  SUPPORTED_RESOURCE_SECTION
} from '~/constants/resource'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { useUserStore } from '~/store/userStore'
import type { PatchResource } from '~/types/api/patch'

export type ResourceFormData = z.infer<typeof patchResourceCreateSchema>

interface CreateResourceProps {
  patchId: number
  onClose: () => void
  onSuccess?: (res: PatchResource) => void
}

const userRoleStorageMap: Record<number, string> = {
  1: 'user',
  2: 's3',
  3: 's3',
  4: 'touchgal'
}

export const PublishResource = ({
  patchId,
  onClose,
  onSuccess
}: CreateResourceProps) => {
  const createDefaultLink = (section: string) => ({
    storage:
      section === 'galgame'
        ? user.role > 3
          ? 'touchgal'
          : 'user'
        : userRoleStorageMap[user.role],
    hash: '',
    content: '',
    size: '',
    code: '',
    password: ''
  })

  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const [uploadingResource, setUploadingResource] = useState(false)
  const user = useUserStore((state) => state.user)
  const needsSectionPreselection = user.role <= 2
  const [sectionConfirmed, setSectionConfirmed] = useState(
    !needsSectionPreselection
  )

  const {
    control,
    reset,
    setValue,
    formState: { errors },
    watch
  } = useForm<ResourceFormData>({
    resolver: zodResolver(patchResourceCreateSchema),
    defaultValues: {
      patchId,
      name: '',
      section: user.role > 2 ? 'galgame' : 'patch',
      type: [],
      language: [],
      platform: [],
      emulatorType: [],
      modelName: '',
      note: '',
      links: [createDefaultLink(user.role > 2 ? 'galgame' : 'patch')]
    }
  })

  const handleRewriteResource = async () => {
    if (creatingRef.current || uploadingResource) {
      return
    }

    creatingRef.current = true
    setCreating(true)
    try {
      const res = await kunFetchPost<KunResponse<PatchResource>>(
        '/patch/resource',
        watch()
      )
      kunErrorHandler(res, (value) => {
        reset()
        if (value.status === 2) {
          toast.success('资源已提交审核，通过后将自动显示')
          onClose()
        } else {
          onSuccess?.(value)
          toast.success('发布成功')
        }
      })
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  const progress = Math.min((user.dailyUploadLimit / 5120) * 100, 100)

  const sectionIcons: Record<string, ReactNode> = {
    galgame: <Gamepad2 className="size-8" />,
    patch: <Puzzle className="size-8" />
  }

  return (
    <ModalContent>
      <ModalHeader className="flex-col space-y-2">
        <h3 className="text-lg">发布资源</h3>
        {(sectionConfirmed || !needsSectionPreselection) && (
          <div className="text-sm font-medium text-default-500">
            {user.role > 1 ? (
              <div className="space-y-1">
                <p>每日上传总额度为 5GB (5120MB)，上传越多可用额度越高。</p>
                <p>{`今日剩余上传额度 ${user.dailyUploadLimit.toFixed(3)} MB`}</p>
                <Progress
                  size="sm"
                  value={progress}
                  aria-label="今日上传额度"
                />
              </div>
            ) : (
              <>
                普通用户至少上传 3
                个有效资源后可申请创作者，创作者每日上传额度更高，详情见
                <Link href="/apply">创作者申请页面</Link>
              </>
            )}
          </div>
        )}
      </ModalHeader>

      <ModalBody>
        {needsSectionPreselection && !sectionConfirmed ? (
          <div className="flex flex-col items-center justify-center gap-6 py-8">
            <h3 className="text-xl font-semibold">请先选择资源的类别</h3>
            <div className="flex gap-4">
              {SUPPORTED_RESOURCE_SECTION.map((s) => (
                <Button
                  key={s}
                  size="lg"
                  variant="bordered"
                  className="flex h-24 w-40 flex-col gap-2"
                  onPress={() => {
                    setValue('section', s)
                    setValue('links', [createDefaultLink(s)])
                    setValue(
                      'type',
                      watch().type.filter((t) =>
                        RESOURCE_SECTION_TYPE_MAP[s]?.includes(t)
                      )
                    )
                    setSectionConfirmed(true)
                  }}
                >
                  {sectionIcons[s]}
                  {RESOURCE_SECTION_MAP[s]}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <form className="space-y-6">
            {!needsSectionPreselection && (
              <ResourceSectionSelect
                errors={errors}
                section={watch().section}
                setSection={(content) => {
                  setValue('section', content)
                  setValue('links', [createDefaultLink(content)])
                  setValue(
                    'type',
                    watch().type.filter((t) =>
                      RESOURCE_SECTION_TYPE_MAP[content]?.includes(t)
                    )
                  )
                }}
              />
            )}

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
        )}
      </ModalBody>

      <ModalFooter className="flex-col items-end">
        <div className="space-x-2">
          <Button color="danger" variant="light" onPress={onClose}>
            取消
          </Button>
          {(sectionConfirmed || !needsSectionPreselection) && (
            <Button
              color="primary"
              disabled={creating || uploadingResource}
              isLoading={creating}
              endContent={<Upload className="size-4" />}
              onPress={handleRewriteResource}
            >
              提交资源
            </Button>
          )}
        </div>

        {creating && (
          <p className="text-xs text-default-500">
            正在提交资源，请不要关闭此窗口，提交完成后会有提示。
          </p>
        )}
      </ModalFooter>
    </ModalContent>
  )
}
