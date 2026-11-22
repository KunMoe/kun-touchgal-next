'use client'

import { useState } from 'react'
import { Button } from '@heroui/button'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import { kunFetchPost } from '~/utils/kunFetch'
import { Check, Plus } from 'lucide-react'
import { useUserStore } from '~/store/userStore'
import { errorReporter, kunErrorHandler } from '~/utils/kunErrorHandler'

// 受控: 关注状态归宿主, 只在关注 / 取消关注成功后经 onChange 上报.
// 要不要刷新路由由宿主决定: /[id] 上每次刷新都会重跑页面读取器、多计一次浏览量
interface Props {
  uid: number
  name: string
  isFollow: boolean
  fullWidth?: boolean
  size?: 'sm' | 'md' | 'lg'
  onChange: (next: boolean) => void
}

export const UserFollow = ({
  uid,
  name,
  isFollow,
  fullWidth = true,
  size,
  onChange
}: Props) => {
  const user = useUserStore((state) => state.user)
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [following, setFollowing] = useState(false)

  const handleUnfollow = async () => {
    setFollowing(true)
    try {
      const res = await kunFetchPost<KunResponse<{}>>('/user/follow/unfollow', {
        uid
      })
      kunErrorHandler(res, () => {
        onChange(false)
        onClose()
      })
    } catch (error) {
      errorReporter(error)
    } finally {
      setFollowing(false)
    }
  }

  const handleFollow = async () => {
    setFollowing(true)

    try {
      if (isFollow) {
        onOpen()
      } else {
        const res = await kunFetchPost<KunResponse<{}>>('/user/follow/follow', {
          uid
        })
        kunErrorHandler(res, () => onChange(true))
      }
    } catch (error) {
      errorReporter(error)
    } finally {
      setFollowing(false)
    }
  }

  return (
    <>
      <Button
        startContent={
          isFollow ? <Check className="size-4" /> : <Plus className="size-4" />
        }
        color={isFollow ? 'success' : 'primary'}
        variant="flat"
        fullWidth={fullWidth}
        size={size}
        onPress={handleFollow}
        isDisabled={following || user.uid === uid || !user.uid}
        isLoading={following}
      >
        {isFollow ? '已关注' : '关注'}
      </Button>

      <Modal isOpen={isOpen} onClose={onClose} placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">取消关注</ModalHeader>
          <ModalBody>
            <p>您确定要取消关注 {name} 吗?</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onClose}>
              取消
            </Button>
            <Button
              color="danger"
              onPress={handleUnfollow}
              isDisabled={following}
              isLoading={following}
            >
              取消关注
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}
