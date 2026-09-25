'use client'

import {
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/react'
import { Button } from '@heroui/button'
import { useRouter } from '@bprogress/next/app'
import toast from 'react-hot-toast'
import { useState } from 'react'
import { kunFetchPost } from '~/utils/kunFetch'
import { useSettingStore } from '~/store/settingStore'

export const Reset = () => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  const handleResetData = async () => {
    localStorage.clear()
    useSettingStore.persist.clearStorage()
    onClose()

    setLoading(true)
    try {
      await kunFetchPost<KunResponse<{}>>('/user/status/logout')
      toast.success('您已成功清除网站所有数据, 请重新登录')
    } catch {
      toast.error('本地数据已清除, 但退出登录失败, 页面即将刷新')
    } finally {
      setLoading(false)
    }

    router.push('/login')

    await new Promise((resolve) => {
      setTimeout(resolve, 3000)
    })
    location.reload()
  }

  return (
    <Card className="w-full overflow-hidden rounded-[22px] border border-danger/20 bg-background text-sm shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
      <CardHeader className="flex-col items-start gap-1 px-5 pb-0 pt-5">
        <h2 className="text-xl font-semibold text-danger">清除网站数据</h2>
        <p className="max-w-2xl leading-6 text-default-500">
          仅清除当前设备上的网站缓存和本地状态，不会删除账户资料。
        </p>
      </CardHeader>
      <CardBody className="space-y-4 overflow-visible px-5 py-4">
        <div className="rounded-2xl border border-danger/20 bg-danger/5 p-4 text-danger-600">
          <p className="leading-6">
            如果搜索页面等功能因本地缓存异常报错，可以尝试清除网站数据。
            清除后需要重新登录。
          </p>
        </div>
      </CardBody>

      <CardFooter className="flex flex-col items-start gap-3 border-t border-danger/10 bg-danger/5 px-5 py-4 sm:flex-row sm:items-center">
        <p className="min-w-0 flex-1 leading-6 text-danger">
          注意，清除操作无法撤销。
        </p>

        <Button
          color="danger"
          variant="solid"
          className="w-full sm:ml-auto sm:w-auto"
          onPress={onOpen}
          isLoading={loading}
        >
          清除
        </Button>
      </CardFooter>

      <Modal isOpen={isOpen} onClose={onClose} placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            您确定要清除网站所有数据吗
          </ModalHeader>
          <ModalBody>
            <p>
              清除网站数据将会清除您当前设备所有的网站缓存数据,
              并且需要重新登录, 清除操作不会对您的账户信息产生任何影响
            </p>
          </ModalBody>
          <ModalFooter>
            <Button color="danger" variant="light" onPress={onClose}>
              关闭
            </Button>
            <Button
              isLoading={loading}
              color="primary"
              onPress={handleResetData}
            >
              确定
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Card>
  )
}
