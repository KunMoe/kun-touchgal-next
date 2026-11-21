'use client'

import { useEffect, useRef, useState } from 'react'
import { Button, Modal, ModalBody, ModalContent } from '@heroui/react'
import { CircleAlert } from 'lucide-react'
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

// 进度环与对勾照 cap-widget 原来可见时的样子画 (它的 src/cap.css、内嵌的对勾 SVG 与刷新进度的节拍),
// 换成本站自己的界面之后用户看到的动画不变
const KUN_CAP_RING_LENGTH = 2 * Math.PI * 14
const KUN_CAP_RING_TICK_MS = 150

// 环放大到 1.1 倍、半径 14、线宽 3, 进度变化用 0.3s ease 过渡。
// 原来的 widget 每 150ms 才把进度刷到环上一次, 环是一段一段缓动过去的; 现在进度事件逐题到达,
// 所以这里按同样的节拍取样, 不是每来一个事件就动一下
const KunCapRing = ({ progress }: { progress: number }) => {
  const latest = useRef(progress)
  const [shown, setShown] = useState(0)

  useEffect(() => {
    latest.current = progress
  }, [progress])

  useEffect(() => {
    const timer = setInterval(
      () => setShown(latest.current),
      KUN_CAP_RING_TICK_MS
    )
    return () => clearInterval(timer)
  }, [])

  return (
    <svg viewBox="0 0 32 32" className="size-full scale-110 -rotate-90">
      <circle
        cx="16"
        cy="16"
        r="14"
        fill="none"
        strokeWidth="3"
        className="stroke-default-200"
      />
      <circle
        cx="16"
        cy="16"
        r="14"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="87.96"
        className="stroke-primary transition-[stroke-dashoffset] duration-300 ease-[ease] motion-reduce:transition-none"
        style={{ strokeDashoffset: KUN_CAP_RING_LENGTH * (1 - shown / 100) }}
      />
    </svg>
  )
}

// 按钮左侧 25px 的指示位: 空勾选框 → 进度环 → 对勾 / 出错
const KunCapIndicator = ({ state }: { state: KunCapState }) => {
  switch (state.status) {
    case 'solving':
      return <KunCapRing progress={state.progress} />
    case 'solved':
      // 勾选框去掉边线, 对勾用 0.5s ease 一笔描出
      return (
        <span className="size-full rounded-md border-small border-transparent bg-default-100">
          <svg viewBox="0 0 24 24" className="block size-full">
            <path
              d="m5 12 5 5L20 7"
              fill="none"
              stroke="#00a67d"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="animate-cap-check [--cap-check-length:23.21320343017578px] [stroke-dasharray:var(--cap-check-length)]"
            />
          </svg>
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
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // 页面一挂载就取厂商的分块与 wasm, 打开弹窗时不用再等网络; 取不到留给打开时那一次去报
    preloadKunCap().catch(() => {})
  }, [])

  useEffect(() => {
    // 弹窗里只有这一个可操作的控件, 打开时把焦点放上去 (否则焦点停在弹窗容器上, 要再按一次 Tab)。
    // HeroUI Button 的 autoFocus 属性不起作用 (只拿去当焦点环的初始状态), 所以自己聚焦
    if (isOpen) {
      buttonRef.current?.focus()
    }
  }, [isOpen])

  const { label, announcement } = describeKunCap(state)

  return (
    <Modal isOpen={isOpen} onClose={onClose} placement="center" hideCloseButton>
      <ModalContent aria-label="人机验证" className="w-fit">
        <ModalBody className="items-center justify-center p-4">
          {/* 不可点时只标 aria-disabled (按下去由 solve 自己忽略), 焦点要留在按钮上:
              isDisabled / isLoading 会落成原生 disabled, pointer-events-none 会让鼠标点击落到弹窗上,
              两者都会把焦点从按钮挪走 */}
          <Button
            ref={buttonRef}
            variant="bordered"
            radius="lg"
            disableRipple
            className={cn(
              'h-[58px] w-[260px] justify-start gap-[15px] border-small border-default-200 px-3.5 text-[15px] font-medium',
              // 悬停时不要 HeroUI 默认的 80% 不透明度 (点完之后鼠标还停在按钮上, 进度环与对勾会被一起冲淡),
              // 改用 cap-widget 原来的 brightness(98%); 它作用在按钮自己画的东西上, 所以按钮要有自己的底色
              'bg-content1 data-[hover=true]:!opacity-100 data-[hover=true]:brightness-[.98]',
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
