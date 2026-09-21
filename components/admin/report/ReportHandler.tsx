'use client'

import { Button } from '@heroui/button'
import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger
} from '@heroui/dropdown'
import { MoreVertical } from 'lucide-react'
import { useUserStore } from '~/store/userStore'
import { buildPatchLink } from './buildPatchLink'
import type { AdminReport } from '~/types/api/admin'

interface Props {
  report: AdminReport
}

export const ReportHandler = ({ report }: Props) => {
  const currentUser = useUserStore((state) => state.user)
  const patchLink = buildPatchLink(report)
  // 资源评论的深链落点是资源详情页而非游戏详情页, 文案跟着落点走
  const isResourceComment =
    report.targetType === 'comment' && !!report.comment?.resourceId
  const userLink = report.reportedUser
    ? `/user/${report.reportedUser.id}/comment`
    : ''
  const disabledKeys = [
    ...(patchLink ? [] : ['game']),
    ...(userLink ? [] : ['user'])
  ]

  return (
    <Dropdown>
      <DropdownTrigger>
        <Button
          isIconOnly
          aria-label="举报操作菜单"
          size="sm"
          variant="light"
          isDisabled={currentUser.role < 3}
        >
          <MoreVertical size={16} />
        </Button>
      </DropdownTrigger>
      <DropdownMenu disabledKeys={disabledKeys}>
        <DropdownItem
          key="game"
          onPress={() => {
            if (patchLink) {
              window.open(patchLink, '_blank', 'noopener,noreferrer')
            }
          }}
        >
          {isResourceComment ? '前往资源' : '前往游戏'}
        </DropdownItem>
        <DropdownItem
          key="user"
          onPress={() => {
            if (userLink) {
              window.open(userLink, '_blank', 'noopener,noreferrer')
            }
          }}
        >
          前往用户
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  )
}
