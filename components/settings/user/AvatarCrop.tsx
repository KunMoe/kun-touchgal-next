'use client'

import { useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import dynamic from 'next/dynamic'
import { useShallow } from 'zustand/react/shallow'
import { Avatar } from '@heroui/react'
import { useDisclosure } from '@heroui/react'
import { useUserStore } from '~/store/userStore'
import { useModerationPending } from '~/hooks/useModerationPending'
import { Camera } from 'lucide-react'

const AvatarCropModal = dynamic(
  () => import('./AvatarCropModal').then((mod) => mod.AvatarCropModal),
  { ssr: false }
)

export const AvatarCrop = () => {
  const { user, setUser } = useUserStore(
    useShallow((state) => ({ user: state.user, setUser: state.setUser }))
  )
  const { isOpen, onOpen, onClose } = useDisclosure()
  const inputRef = useRef<HTMLInputElement>(null)
  const [image, setImage] = useState<string | null>(null)
  const [croppedImage, setCroppedImage] = useState<string | null>(null)
  const { pending, markPending } = useModerationPending('avatarPending')

  const onSelectFile = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const reader = new FileReader()
      reader.addEventListener('load', () => {
        setImage(reader.result as string)
        onOpen()
      })
      reader.readAsDataURL(e.target.files[0])
    }
    // 清空 value: 同一文件再次选择时浏览器不触发 change (取消裁剪后重选同图会静默失败)
    e.target.value = ''
  }

  const handleUploadKeyDown = (event: KeyboardEvent<HTMLLabelElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    inputRef.current?.click()
  }

  const handleUploaded = (
    croppedImage: string,
    avatar: string,
    pending?: boolean
  ) => {
    setCroppedImage(croppedImage)
    setUser({ ...user, avatar })
    markPending(!!pending)
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative">
        <div className="group relative">
          {croppedImage ? (
            <img
              src={croppedImage}
              alt="裁剪后的头像"
              className="size-20 rounded-full object-cover"
            />
          ) : (
            <Avatar
              name={user.name}
              src={user.avatar}
              className="h-20 w-20"
              color="primary"
            />
          )}

          <label
            htmlFor="avatar-upload"
            aria-label="上传头像"
            tabIndex={0}
            onKeyDown={handleUploadKeyDown}
            className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-full bg-black/45 text-background opacity-100 transition-opacity duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
          >
            <Camera className="size-6" />
          </label>
          <input
            ref={inputRef}
            id="avatar-upload"
            type="file"
            accept="image/*"
            tabIndex={-1}
            className="sr-only"
            onChange={onSelectFile}
          />
        </div>
      </div>

      {pending && (
        <p className="text-center text-sm text-warning-600 dark:text-warning-500">
          头像审核中，通过后对所有人可见
        </p>
      )}

      {isOpen && image && (
        <AvatarCropModal
          image={image}
          isOpen={isOpen}
          onClose={onClose}
          onUploaded={handleUploaded}
        />
      )}
    </div>
  )
}
