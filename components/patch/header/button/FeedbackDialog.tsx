'use client'

import { useState } from 'react'
import { Button } from '@heroui/button'
import { Textarea } from '@heroui/input'
import { ModalBody, ModalFooter } from '@heroui/modal'
import toast from 'react-hot-toast'
import { kunFetchPost } from '~/utils/kunFetch'

interface Props {
  patchId: number
  patchName: string
  inputValue: string
  onInputChange: (value: string) => void
  onSubmitSuccess: () => void
  onClose: () => void
}

export const FeedbackDialog = ({
  patchId,
  patchName,
  inputValue,
  onInputChange,
  onSubmitSuccess,
  onClose
}: Props) => {
  const [submitting, setSubmitting] = useState(false)

  const handleSubmitFeedback = async () => {
    setSubmitting(true)
    const res = await kunFetchPost<KunResponse<{}>>('/patch/feedback', {
      patchId,
      content: inputValue
    })
    // 失败时弹窗不关, 可以直接重试
    if (typeof res === 'string') {
      toast.error(res)
    } else {
      onSubmitSuccess()
      toast.success('提交反馈成功')
      onClose()
    }
    setSubmitting(false)
  }

  return (
    <>
      <ModalBody>
        <Textarea
          label={`游戏 ${patchName} 的反馈`}
          isRequired
          placeholder="请填写反馈内容 (游戏错误, 资源失效, 游戏介绍错误等等, 请尽可能详细并指明具体的位置)"
          value={inputValue}
          onChange={(event) => onInputChange(event.target.value)}
        />
      </ModalBody>
      <ModalFooter>
        <Button variant="light" onPress={onClose}>
          取消
        </Button>
        <Button
          color="primary"
          onPress={handleSubmitFeedback}
          isDisabled={submitting}
          isLoading={submitting}
        >
          提交
        </Button>
      </ModalFooter>
    </>
  )
}

export default FeedbackDialog
