'use client'

import { useEffect } from 'react'
import {
  Button,
  CircularProgress,
  Modal,
  ModalBody,
  ModalContent
} from '@heroui/react'
import { Check, CircleAlert } from 'lucide-react'
import { cn } from '~/utils/cn'
import { preloadKunCap, useKunCap } from '~/components/kun/auth/useKunCap'
import type { KunCapState } from '~/components/kun/auth/useKunCap'

interface CaptchaModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: (code: string) => void
}

// 每个状态下按钮上的字与读屏播报的话。按钮的可访问名称就是可见的字, 不另写 aria-label
const describeKunCap = (state: KunCapState) => {
  switch (state.status) {
    case 'loading':
      return { label: '正在加载...', announcement: '' }
    case 'idle':
      return { label: '我是真人', announcement: '' }
    case 'solving':
      return { label: '正在验证...', announcement: '正在验证, 请稍候' }
    case 'solved':
      return { label: '验证通过', announcement: '验证通过, 您可以继续操作' }
    case 'error':
      return state.code === 'load_failed'
        ? { label: '加载失败, 请点击重试', announcement: '加载失败, 请重试' }
        : { label: '验证出错, 请点击重试', announcement: '验证出错, 请重试' }
  }
}

// 按钮左侧 25px 的指示位: 空勾选框 → 进度环 → 对勾 / 出错
const KunCapIndicator = ({ state }: { state: KunCapState }) => {
  switch (state.status) {
    case 'solving':
      return (
        <CircularProgress
          aria-label="验证进度"
          value={state.progress}
          classNames={{ svg: 'size-[25px]', track: 'stroke-default-200' }}
        />
      )
    case 'solved':
      return (
        <span className="flex size-full items-center justify-center rounded-full bg-success text-success-foreground">
          <Check className="size-4" strokeWidth={3} />
        </span>
      )
    case 'error':
      return <CircleAlert className="size-full text-danger" />
    default:
      return (
        <span className="size-full rounded-md border-small border-default-400 bg-default-100" />
      )
  }
}

export const KunCaptchaModal = ({
  isOpen,
  onClose,
  onSuccess
}: CaptchaModalProps) => {
  const { state, canSolve, solve } = useKunCap(isOpen, onSuccess)

  useEffect(() => {
    // 页面一挂载就取厂商的分块与 wasm, 打开弹窗时不用再等网络; 取不到留给打开时那一次去报
    preloadKunCap().catch(() => {})
  }, [])

  const { label, announcement } = describeKunCap(state)

  return (
    <Modal isOpen={isOpen} onClose={onClose} placement="center" hideCloseButton>
      <ModalContent aria-label="人机验证" className="w-fit">
        <ModalBody className="items-center justify-center p-4">
          {/* 不可点时只标 aria-disabled (按下去由 solve 自己忽略), 焦点要留在按钮上:
              isDisabled / isLoading 会落成原生 disabled, pointer-events-none 会让鼠标点击落到弹窗上,
              两者都会把焦点从按钮挪走 */}
          <Button
            variant="bordered"
            radius="lg"
            disableRipple
            className={cn(
              'h-[58px] w-[260px] justify-start gap-[15px] border-small border-default-200 px-3.5 text-[15px] font-medium',
              !canSolve && 'cursor-default'
            )}
            aria-disabled={!canSolve}
            aria-busy={state.status === 'loading' || state.status === 'solving'}
            startContent={
              <span className="flex size-[25px] shrink-0 items-center justify-center">
                <KunCapIndicator state={state} />
              </span>
            }
            onPress={solve}
          >
            {label}
          </Button>
          <span role="status" className="sr-only">
            {announcement}
          </span>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}
