'use client'

import { useShallow } from 'zustand/react/shallow'
import { Card, CardBody, CardFooter, CardHeader } from '@heroui/card'
import { Input } from '@heroui/input'
import { Button } from '@heroui/button'
import { useUserStore } from '~/store/userStore'
import { useState } from 'react'
import { kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { usernameSchema } from '~/validations/user'
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/modal'
import toast from 'react-hot-toast'

export const Username = () => {
  const { user, setUser } = useUserStore(
    useShallow((state) => ({ user: state.user, setUser: state.setUser }))
  )
  // draft 为 null 表示尚未编辑, 此时显示 store 里的当前用户名. 不能用 useState(user.name)
  // 做初值: user store 在顶栏 effect 里 post-mount 才水合, 硬刷新时首帧 user.name 为 ''
  const [draft, setDraft] = useState<string | null>(null)
  const username = draft ?? user.name
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { isOpen, onOpen, onOpenChange } = useDisclosure()

  const handleSave = async () => {
    if (user.moemoepoint < 30) {
      toast.error('更改用户名最少需要 30 萌萌点, 您的萌萌点不足')
      return
    }

    const result = usernameSchema.safeParse({ username })
    if (!result.success) {
      setError(result.error.issues[0].message)
    } else {
      setError('')

      setLoading(true)
      // 发送与写回 store 都用 schema 解析后的值 (已 trim), 原因见 Bio.tsx
      const nextName = result.data.username

      try {
        const res = await kunFetchPost<KunResponse<{}>>(
          '/user/setting/username',
          { username: nextName }
        )
        kunErrorHandler(res, () => {
          toast.success('更新用户名成功')
          setUser({
            ...user,
            name: nextName,
            moemoepoint: user.moemoepoint - 30
          })
          setDraft(null)
        })
      } catch {
        toast.error('更新用户名失败, 请稍后重试')
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <Card className="w-full overflow-hidden rounded-[22px] border border-default-200/60 bg-background text-sm shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
      <CardHeader className="flex-col items-start gap-1 px-5 pb-0 pt-5">
        <h2 className="text-xl font-semibold text-foreground">用户名</h2>
        <p className="max-w-2xl leading-6 text-default-500">
          用户名会显示在主页、评论和消息中，修改前请确认拼写。
        </p>
      </CardHeader>
      <CardBody className="space-y-4 overflow-visible px-5 py-4">
        <Input
          label="用户名"
          autoComplete="text"
          value={username}
          onChange={(e) => setDraft(e.target.value)}
          isInvalid={!!error}
          errorMessage={error}
        />
      </CardBody>

      <CardFooter className="flex flex-col items-start gap-3 border-t border-default-100 bg-default-50/60 px-5 py-4 sm:flex-row sm:items-center dark:bg-default-100/10">
        <p className="min-w-0 flex-1 leading-6 text-default-500">
          用户名长度最大为 17，可以是任意字符。更改用户名需要消耗 30 萌萌点。
        </p>

        <Button
          color="primary"
          variant="solid"
          className="w-full sm:ml-auto sm:w-auto"
          isDisabled={username.trim() === user.name}
          onPress={onOpen}
        >
          保存
        </Button>

        <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader className="flex flex-col gap-1">
                  您确定要更改用户名吗?
                </ModalHeader>
                <ModalBody>
                  <p>更改用户名需要消耗您 30 萌萌点, 该操作不可撤销</p>
                </ModalBody>
                <ModalFooter>
                  <Button color="danger" variant="light" onPress={onClose}>
                    关闭
                  </Button>
                  <Button
                    color="primary"
                    onPress={() => {
                      handleSave()
                      onClose()
                    }}
                    isLoading={loading}
                    disabled={loading}
                  >
                    确定
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>
      </CardFooter>
    </Card>
  )
}
