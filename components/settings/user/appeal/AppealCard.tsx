'use client'

import { Button } from '@heroui/button'
import { Chip } from '@heroui/chip'
import { Modal, useDisclosure } from '@heroui/modal'
import { withUnchangedFields } from '~/utils/appealPayload'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { KunAppealPayload } from '~/components/kun/AppealPayload'
import {
  MODERATION_CONTENT_TYPE_MAP,
  MODERATION_REJECT_CODE_MAP
} from '~/constants/moderation'
import { AppealDialog } from './AppealDialog'
import type { UserAppealItem, UserAppealState } from '~/types/api/appeal'

interface Props {
  item: UserAppealItem
  onRefresh: () => void
}

const stateChipMap: Record<
  UserAppealState,
  {
    label: string
    color: 'warning' | 'primary' | 'success' | 'danger' | 'default'
  }
> = {
  appealable: { label: '可申诉', color: 'warning' },
  pending: { label: '申诉待处理', color: 'primary' },
  approved: { label: '申诉已通过', color: 'success' },
  rejected: { label: '申诉已拒绝', color: 'danger' },
  unavailable: { label: '已失效', color: 'default' }
}

export const AppealCard = ({ item, onRefresh }: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()

  // 申诉只能提交一次, 仅未申诉的内容可申诉; 提交后进入只读展示
  const editable = item.state === 'appealable'
  const stateChip = stateChipMap[item.state]
  // 弹窗的尺寸与关闭方式沿用各类型原有的编辑弹窗; 一律只能经按钮关闭, 免得误触
  // 遮罩或 Esc 丢掉改到一半的内容
  const modalSize =
    item.contentType === 'resource'
      ? '3xl'
      : item.contentType === 'comment'
        ? '2xl'
        : 'md'

  return (
    <div className="space-y-3 rounded-2xl border border-default-200/60 bg-default-50/60 p-4 dark:bg-default-100/10">
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="flat">
          {MODERATION_CONTENT_TYPE_MAP[item.contentType]}
        </Chip>
        <Chip size="sm" variant="flat" color={stateChip.color}>
          {stateChip.label}
        </Chip>
        {item.patchName && (
          <span className="text-sm text-default-500">{item.patchName}</span>
        )}
        {item.rejectedAt && (
          <span className="ml-auto text-sm text-default-400">
            <KunTimeAgo date={item.rejectedAt} />
          </span>
        )}
      </div>

      {/* 申诉通过 (approveAppeal 不改写 task.status, 条目仍留在列表里) 与已失效的内容
          都已恢复展示或不复存在, 再挂一条红色拒绝原因与状态 chip 自相矛盾. 只展示表内
          码的类别名: 表外码 (多重违规码, 或管理员改判时留空) 对用户没有指向性 */}
      {item.state !== 'approved' && item.state !== 'unavailable' && (
        <p className="text-sm text-danger-500">
          未通过原因：
          {MODERATION_REJECT_CODE_MAP[item.rejectCode] ?? '包含违规内容'}
        </p>
      )}

      {item.original ? (
        <div className="space-y-1 text-sm">
          <p className="text-default-500">原内容：</p>
          <div className="rounded-lg bg-default-100 p-2 text-default-600">
            <KunAppealPayload
              contentType={item.contentType}
              payload={item.original}
            />
          </div>
        </div>
      ) : (
        <p className="text-sm text-default-400">内容已被删除</p>
      )}

      {editable && (
        <>
          <div className="flex justify-end">
            <Button color="primary" size="sm" onPress={onOpen}>
              申诉
            </Button>
          </div>

          <Modal
            size={modalSize}
            isOpen={isOpen}
            onClose={onClose}
            scrollBehavior={
              item.contentType === 'resource' ? 'outside' : 'normal'
            }
            isDismissable={false}
            isKeyboardDismissDisabled={true}
          >
            <AppealDialog
              item={item}
              onClose={onClose}
              onSuccess={() => {
                onClose()
                onRefresh()
              }}
            />
          </Modal>
        </>
      )}

      {!editable && item.appeal && (
        <div className="space-y-1 text-sm">
          <p className="text-default-500">申诉提交的内容：</p>
          <div className="rounded-lg bg-default-100 p-2 text-default-600">
            <KunAppealPayload
              contentType={item.contentType}
              payload={withUnchangedFields(item.appeal.payload, item.original)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
