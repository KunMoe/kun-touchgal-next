'use client'

import { Button } from '@heroui/button'
import { BadgeCheck, Pencil, Shield } from 'lucide-react'
import { useRouter } from '@bprogress/next/app'
import type { UserInfo } from '~/types/api/user'

interface Props {
  user: UserInfo
}

export const SelfButton = ({ user }: Props) => {
  const router = useRouter()
  const isShowAdminButton = user.id === user.requestUserUid && user.role > 3

  return (
    <div className="flex-col w-full space-y-3">
      <div className="flex space-x-3">
        <Button
          startContent={<Pencil className="size-4" />}
          color="primary"
          variant="flat"
          fullWidth
          onPress={() => router.push('/settings/user')}
        >
          编辑信息
        </Button>

        {isShowAdminButton && (
          <Button
            startContent={<Shield className="size-4" />}
            color="primary"
            variant="solid"
            fullWidth
            onPress={() => router.push('/admin')}
          >
            管理面板
          </Button>
        )}
      </div>

      {user.role < 2 && (
        <Button
          startContent={<BadgeCheck className="size-4" />}
          color="primary"
          fullWidth
          onPress={() => router.push('/apply')}
        >
          申请成为创作者
        </Button>
      )}
    </div>
  )
}
