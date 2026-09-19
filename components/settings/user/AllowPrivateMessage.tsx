'use client'

import { useShallow } from 'zustand/react/shallow'
import { Card, CardBody, CardFooter, CardHeader } from '@heroui/card'
import { useUserStore } from '~/store/userStore'
import { kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import toast from 'react-hot-toast'
import { Switch } from '@heroui/react'

export const AllowPrivateMessage = () => {
  const { user, setUser } = useUserStore(
    useShallow((state) => ({ user: state.user, setUser: state.setUser }))
  )

  const handleToggleAllowPrivateMessage = async (value: boolean) => {
    if (!user.uid) {
      toast.error('请先登录以使用此功能')
      return
    }

    try {
      const res = await kunFetchPost<KunResponse<{}>>(
        `/user/setting/allow-private-message`,
        { allowPrivateMessage: value }
      )
      kunErrorHandler(res, () => {
        setUser({ ...user, allowPrivateMessage: value })
        toast.success(value ? '已允许接收私信' : '已关闭接收私信')
      })
    } catch {
      toast.error('更新私信设置失败, 请稍后重试')
    }
  }

  return (
    <Card className="w-full overflow-hidden rounded-[22px] border border-default-200/60 bg-background text-sm shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
      <CardHeader className="flex-col items-start gap-1 px-5 pb-0 pt-5">
        <h2 className="text-xl font-semibold text-foreground">私信设置</h2>
        <p className="max-w-2xl leading-6 text-default-500">
          控制其他用户是否可以向您发起新的私信会话。
        </p>
      </CardHeader>
      <CardBody className="space-y-4 overflow-visible px-5 py-4">
        <div className="rounded-2xl border border-default-200 bg-default-50/70 p-4 dark:bg-default-100/10">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="font-medium text-foreground">是否允许接收私信</p>
              <p className="leading-6 text-default-500">
                关闭后，其他用户无法创建新的私信会话。
              </p>
            </div>
            <Switch
              size="lg"
              color="primary"
              aria-label="允许接收私信"
              isSelected={user.allowPrivateMessage}
              onValueChange={handleToggleAllowPrivateMessage}
            />
          </div>
        </div>
      </CardBody>

      <CardFooter className="border-t border-default-100 bg-default-50/60 px-5 py-4 text-default-500 dark:bg-default-100/10">
        <p className="leading-6">已有会话不受影响，设置仅影响新的私信发起。</p>
      </CardFooter>
    </Card>
  )
}
