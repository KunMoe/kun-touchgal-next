'use client'

import { Chip } from '@heroui/react'
import { USER_STATUS_COLOR_MAP, USER_STATUS_MAP } from '~/constants/user'
import { KUN_ROLE_LABEL, toKunRole } from '~/constants/role'
import { UserEdit } from './UserEdit'
import { UserDelete } from './UserDelete'
import { KunUser } from '~/components/kun/floating-card/KunUser'
import type { AdminUser as AdminUserType } from '~/types/api/admin'

interface RenderActions {
  onUpdated: (user: AdminUserType) => void
  onDeleted: (uid: number) => void
}

export const RenderCell = (
  user: AdminUserType,
  columnKey: string,
  actions?: RenderActions
) => {
  switch (columnKey) {
    case 'user':
      return (
        <KunUser
          user={user}
          userProps={{
            name: user.name,
            description: `补丁数 - ${user._count.patch} | 资源数 - ${user._count.patch_resource}`,
            avatarProps: {
              src: user.avatar
            }
          }}
        />
      )
    case 'role':
      return (
        <Chip color="primary" variant="flat">
          {KUN_ROLE_LABEL[toKunRole(user.role)]}
        </Chip>
      )
    case 'status':
      return (
        <Chip color={USER_STATUS_COLOR_MAP[user.status]} variant="flat">
          {USER_STATUS_MAP[user.status]}
        </Chip>
      )
    case 'actions':
      return (
        <div className="flex items-center gap-2">
          <UserEdit initialUser={user} onUpdated={actions?.onUpdated} />
          <UserDelete user={user} onDeleted={actions?.onDeleted} />
        </div>
      )
    default:
      return null
  }
}
