'use client'

import toast from 'react-hot-toast'
import { useEffect, useRef } from 'react'
import { Modal, ModalBody, ModalContent } from '@heroui/react'
import type { CapSolveEvent, CapWidget } from 'cap-widget'

interface CaptchaModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: (code: string) => void
}

export const KunCaptchaModal = ({
  isOpen,
  onClose,
  onSuccess
}: CaptchaModalProps) => {
  const widgetRef = useRef<CapWidget | null>(null)

  useEffect(() => {
    // 与 cap-widget 0.1.57 期望的 @cap.js/wasm@0.0.7 对应, 升级 widget 时
    // 需同步更新 public/cap/cap_wasm_bg.wasm (加载失败会自动降级 JS 解题器)
    window.CAP_CUSTOM_WASM_URL = '/cap/cap_wasm_bg.wasm'
    // 注入 CSRF 头以通过 middleware 校验 (与 utils/kunFetch.ts 一致)
    window.CAP_CUSTOM_FETCH = (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('X-Requested-With', 'kun-fetch')
      return fetch(input, { ...init, headers, credentials: 'include' })
    }
    // 自定义元素注册依赖浏览器 API, 只能在客户端动态导入
    import('cap-widget')
  }, [])

  useEffect(() => {
    const widget = widgetRef.current
    if (!widget || !isOpen) {
      return
    }

    const handleSolve = (event: CapSolveEvent) => {
      onSuccess(event.detail.token)
    }
    const handleError = () => {
      toast.error('人机验证出错, 请重试')
    }

    widget.addEventListener('solve', handleSolve)
    widget.addEventListener('error', handleError)
    return () => {
      widget.removeEventListener('solve', handleSolve)
      widget.removeEventListener('error', handleError)
    }
  }, [isOpen, onSuccess])

  return (
    <Modal isOpen={isOpen} onClose={onClose} placement="center" hideCloseButton>
      <ModalContent aria-label="人机验证" className="w-fit">
        <ModalBody className="items-center justify-center p-4">
          <cap-widget
            ref={widgetRef}
            data-cap-api-endpoint="/api/auth/captcha/"
            data-cap-i18n-initial-state="我是真人"
            data-cap-i18n-verifying-label="正在验证..."
            data-cap-i18n-solved-label="验证通过"
            data-cap-i18n-error-label="验证出错, 请点击重试"
            data-cap-i18n-verify-aria-label="点击进行人机验证"
            data-cap-i18n-verifying-aria-label="正在验证, 请稍候"
            data-cap-i18n-verified-aria-label="验证通过, 您可以继续操作"
            data-cap-i18n-error-aria-label="验证出错, 请重试"
          />
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}
