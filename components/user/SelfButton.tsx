'use client'

import { Button } from '@heroui/button'
import { BadgeCheck, Pencil, Shield } from 'lucide-react'
import { useRouter } from '@bprogress/next/app'
import { can, canApplyCreator } from '~/constants/permission'
import type { UserInfo } from '~/types/api/user'

interface Props {
  user: UserInfo
}

export const SelfButton = ({ user }: Props) => {
  const router = useRouter()
  const isShowAdminButton =
    user.id === user.requestUserUid &&
    can({ uid: user.id, role: user.role }, 'admin.access')

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

      {canApplyCreator({ uid: user.id, role: user.role }) && (
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
