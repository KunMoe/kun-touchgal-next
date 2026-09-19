'use client'

import { useShallow } from 'zustand/react/shallow'
import { Card, CardBody, CardFooter, CardHeader } from '@heroui/card'
import { Textarea } from '@heroui/input'
import { Button } from '@heroui/button'
import { useUserStore } from '~/store/userStore'
import { useModerationPending } from '~/hooks/useModerationPending'
import { useState } from 'react'
import { kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { bioSchema } from '~/validations/user'
import toast from 'react-hot-toast'

export const Bio = () => {
  const { user, setUser } = useUserStore(
    useShallow((state) => ({ user: state.user, setUser: state.setUser }))
  )
  // draft 为 null 表示尚未编辑, 此时显示 store 里的当前签名 (初值不能取 user.bio, 原因见 Username.tsx)
  const [draft, setDraft] = useState<string | null>(null)
  const bio = draft ?? user.bio
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { pending, markPending } = useModerationPending('bioPending')

  const handleSave = async () => {
    const result = bioSchema.safeParse({ bio })
    if (!result.success) {
      setError(result.error.issues[0].message)
    } else {
      setError('')
      setLoading(true)

      try {
        const res = await kunFetchPost<KunResponse<{ pending?: boolean }>>(
          '/user/setting/bio',
          { bio }
        )
        kunErrorHandler(res, (value) => {
          toast.success('更新签名成功')
          // 保存按钮以 bio === user.bio 判未修改: 请求前乐观写 store 会让失败后二者相等, 按钮锁死无法重试
          setUser({ ...user, bio })
          setDraft(null)
          markPending(!!value.pending)
        })
      } catch {
        toast.error('更新签名失败, 请稍后重试')
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <Card className="w-full overflow-hidden rounded-[22px] border border-default-200/60 bg-background text-sm shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
      <CardHeader className="flex-col items-start gap-1 px-5 pb-0 pt-5">
        <h2 className="text-xl font-semibold text-foreground">签名</h2>
        <p className="max-w-2xl leading-6 text-default-500">
          签名会显示在您的个人主页，用一句话介绍自己或当前状态。
        </p>
      </CardHeader>
      <CardBody className="space-y-4 overflow-visible px-5 py-4">
        <Textarea
          label="签名"
          autoComplete="text"
          value={bio}
          onChange={(e) => setDraft(e.target.value)}
          isInvalid={!!error}
          errorMessage={error}
        />
        {pending && (
          <p className="text-sm text-warning-600 dark:text-warning-500">
            签名审核中，通过后对所有人可见
          </p>
        )}
      </CardBody>

      <CardFooter className="flex flex-col items-start gap-3 border-t border-default-100 bg-default-50/60 px-5 py-4 sm:flex-row sm:items-center dark:bg-default-100/10">
        <p className="min-w-0 flex-1 leading-6 text-default-500">
          签名最大长度为 107，可以是任意字符。
        </p>

        <Button
          color="primary"
          variant="solid"
          className="w-full sm:ml-auto sm:w-auto"
          onPress={handleSave}
          isLoading={loading}
          isDisabled={bio.trim() === user.bio}
        >
          保存
        </Button>
      </CardFooter>
    </Card>
  )
}
