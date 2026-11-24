'use client'

import { lazy, Suspense, useState } from 'react'
import { Button } from '@heroui/button'
import { Checkbox } from '@heroui/checkbox'
import { Upload } from 'lucide-react'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/modal'
import { useUserStore } from '~/store/userStore'
import { can } from '~/constants/permission'
import type { Patch } from '~/types/api/patch'

const EditBannerContentFallback = ({ onClose }: { onClose: () => void }) => {
  return (
    <>
      <ModalBody>
        <div className="gap-6 size-full">
          <div className="mb-4 rounded-lg border-2 border-dashed border-default-300 p-4 text-center transition-colors">
            <div className="flex flex-col items-center justify-center">
              <Upload className="mb-4 h-12 w-12 text-default-400" />
              <p className="mb-2">拖放图片到此处或</p>
              <label>
                <Button
                  as="span"
                  color="primary"
                  variant="flat"
                  className="cursor-pointer"
                >
                  选择文件
                </Button>
              </label>
            </div>
          </div>
        </div>

        <p>更改后刷新页面即可看到新图片</p>
        <Checkbox isDisabled>
          立即删除旧图片 (撤下违规图片时勾选, 否则旧图片保留 24 小时)
        </Checkbox>
      </ModalBody>
      <ModalFooter>
        <Button variant="light" onPress={onClose}>
          取消
        </Button>
        <Button color="danger">更改</Button>
      </ModalFooter>
    </>
  )
}

const RewritePatchBanner = lazy(
  () => import('~/components/edit/rewrite/RewritePatchBanner')
)

const preloadRewritePatchBanner = () => {
  void import('~/components/edit/rewrite/RewritePatchBanner')
}

interface PatchHeaderBannerProps {
  patch: Patch
}

export const EditBanner = ({ patch }: PatchHeaderBannerProps) => {
  const [isOpen, setIsOpen] = useState(false)
  const user = useUserStore((state) => state.user)

  return (
    <>
      {can(user, 'banner.edit') && (
        <Button
          color="default"
          variant="shadow"
          size="sm"
          className="absolute z-10 bottom-3 left-3 backdrop-blur-sm bg-background/40"
          onPress={() => setIsOpen(true)}
          onPointerEnter={preloadRewritePatchBanner}
          onFocus={preloadRewritePatchBanner}
          title="更改预览图片"
        >
          更改图片
        </Button>
      )}

      {isOpen && (
        <Modal
          isOpen={isOpen}
          onClose={() => setIsOpen(false)}
          placement="center"
        >
          <ModalContent>
            <ModalHeader className="flex flex-col gap-1">
              更改预览图片
            </ModalHeader>
            <Suspense
              fallback={
                <EditBannerContentFallback onClose={() => setIsOpen(false)} />
              }
            >
              <RewritePatchBanner
                patchId={patch.id}
                onClose={() => setIsOpen(false)}
              />
            </Suspense>
          </ModalContent>
        </Modal>
      )}
    </>
  )
}
