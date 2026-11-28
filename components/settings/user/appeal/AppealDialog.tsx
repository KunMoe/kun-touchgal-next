'use client'

import { useId, useState } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '@heroui/button'
import { Card, CardBody } from '@heroui/card'
import { Chip } from '@heroui/chip'
import { Input, Textarea } from '@heroui/input'
import {
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/modal'
import toast from 'react-hot-toast'
import { kunFetchPost } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { ResourceSizeRegex } from '~/utils/validate'
import { getAppealEditableLinkFields } from '~/utils/appealPayload'
import { KunMarkdownEditor } from '~/components/kun/editor/MarkdownEditor'
import { MODERATION_CONTENT_TYPE_MAP } from '~/constants/moderation'
import { SUPPORTED_RESOURCE_LINK_MAP } from '~/constants/resource'
import type { AppealLink, UserAppealItem } from '~/types/api/appeal'

interface Props {
  item: UserAppealItem
  onClose: () => void
  onSuccess: () => void
}

const SUBMIT_HINT = '申诉提交后不可修改，请确认内容无误后再提交。'

// 申诉弹窗的内容。版式沿用各类型原有的编辑弹窗 (资源: EditResourceDialog 与
// ResourceLinksInput; 评价: RatingModal; 评论: CommentDropdown 的编辑弹窗), 只留申诉
// 可改的字段。随 Modal 关闭而卸载, 每次打开都从原内容重新开始
export const AppealDialog = ({ item, onClose, onSuccess }: Props) => {
  const [text, setText] = useState(item.original?.text ?? '')
  const [name, setName] = useState(item.original?.name ?? '')
  const [note, setNote] = useState(item.original?.note ?? '')
  const [modelName, setModelName] = useState(item.original?.modelName ?? '')
  const [links, setLinks] = useState<AppealLink[]>(item.original?.links ?? [])
  // 资源字段的校验错误在第一次提交尝试之后才显示, 不在用户改到一半时打断
  const [showErrors, setShowErrors] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const fieldId = useId()

  const isResource = item.contentType === 'resource'
  const title = `申诉${MODERATION_CONTENT_TYPE_MAP[item.contentType] ?? ''}`
  // 只有 AI 翻译补丁有模型型号: 服务端只在这类资源的原内容里带上它
  const hasModelName = item.original?.modelName !== undefined
  const modelNameError =
    hasModelName && !modelName.trim() ? '请填写模型型号' : ''

  // 只校验作者可改的字段, 与服务端读同一处规则
  const linkErrors = links.map((link) => {
    const editable = getAppealEditableLinkFields(link.storage)
    return {
      content:
        editable.includes('content') && !link.content.trim()
          ? '请输入资源链接'
          : '',
      size:
        !editable.includes('size') || ResourceSizeRegex.test(link.size)
          ? ''
          : '请填写资源大小, 以 MB 或 GB 结尾, 例如 1.024 GB'
    }
  })

  const updateLink = (index: number, patch: Partial<AppealLink>) =>
    setLinks((prev) =>
      prev.map((link, i) => (i === index ? { ...link, ...patch } : link))
    )

  const handleSubmit = async () => {
    if (!isResource && !text.trim()) {
      toast.error('申诉内容不可为空')
      return
    }
    if (isResource) {
      const invalidIndex = linkErrors.findIndex(
        (error) => error.content || error.size
      )
      // 与弹窗里的字段顺序一致: 先模型型号, 后各条链接
      const firstInvalidId = modelNameError
        ? `${fieldId}-modelName`
        : invalidIndex !== -1
          ? `${fieldId}-${invalidIndex}-${linkErrors[invalidIndex].content ? 'content' : 'size'}`
          : null
      if (firstInvalidId) {
        // 先把错误渲染出来再移焦点: 聚焦到第一个出错的字段时, 错误说明已经挂在它上面
        flushSync(() => setShowErrors(true))
        document.getElementById(firstInvalidId)?.focus()
        return
      }
    }

    const body = isResource
      ? {
          contentType: 'resource',
          taskId: item.taskId,
          name,
          note,
          ...(hasModelName ? { modelName } : {}),
          // 每条链接只提交作者可改的字段
          links: links.map((link) => ({
            id: link.id,
            ...Object.fromEntries(
              getAppealEditableLinkFields(link.storage).map((field) => [
                field,
                link[field]
              ])
            )
          }))
        }
      : item.contentType === 'comment'
        ? { contentType: 'comment', taskId: item.taskId, content: text }
        : { contentType: 'rating', taskId: item.taskId, shortSummary: text }

    setSubmitting(true)
    try {
      const res = await kunFetchPost<KunResponse<{}>>('/user/appeal', body)
      kunErrorHandler(res, () => {
        toast.success('申诉已提交, 请等待管理员复核')
        onSuccess()
      })
    } catch {
      toast.error('提交申诉失败, 请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  const submitButton = (
    <Button
      color="primary"
      onPress={handleSubmit}
      isDisabled={submitting}
      isLoading={submitting}
    >
      提交申诉
    </Button>
  )

  if (!isResource) {
    return (
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          {title}
          <p className="text-sm font-normal text-default-500">{SUBMIT_HINT}</p>
        </ModalHeader>
        {item.contentType === 'comment' ? (
          <ModalBody>
            <KunMarkdownEditor
              value={text}
              onChange={setText}
              minHeight={160}
            />
          </ModalBody>
        ) : (
          <ModalBody className="gap-4">
            <Textarea
              label="简评"
              placeholder="最多 1314 字"
              value={text}
              onValueChange={setText}
              maxRows={10}
              maxLength={1314}
            />
          </ModalBody>
        )}
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            取消
          </Button>
          {submitButton}
        </ModalFooter>
      </ModalContent>
    )
  }

  return (
    <ModalContent>
      <ModalHeader className="flex-col space-y-2">
        <h3 className="text-lg">{title}</h3>
        <p className="text-sm font-medium text-default-500">{SUBMIT_HINT}</p>
      </ModalHeader>

      <ModalBody>
        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-lg font-medium">资源详情</h3>
            <Input
              label="资源标题"
              value={name}
              onValueChange={setName}
              maxLength={300}
            />
            <Textarea
              label="资源介绍"
              value={note}
              onValueChange={setNote}
              maxLength={10007}
            />
            {hasModelName && (
              <Input
                id={`${fieldId}-modelName`}
                label="模型型号"
                value={modelName}
                onValueChange={setModelName}
                isRequired
                maxLength={107}
                isInvalid={showErrors && !!modelNameError}
                errorMessage={showErrors ? modelNameError : undefined}
              />
            )}
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <h3 className="text-lg font-medium">资源链接</h3>
              <p className="text-sm text-default-500">
                申诉只能修改已有链接的内容，不能增删链接或更换存储类型
              </p>
            </div>

            {links.map((link, index) => {
              const editable = getAppealEditableLinkFields(link.storage)
              const canEdit = (field: (typeof editable)[number]) =>
                editable.includes(field)
              const errors = showErrors ? linkErrors[index] : null
              const groupId = `${fieldId}-${index}`
              return (
                <Card key={link.id} className="border border-default-200">
                  <CardBody
                    role="group"
                    aria-labelledby={`${groupId}-title`}
                    className="space-y-4"
                  >
                    <div
                      id={`${groupId}-title`}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <Chip color="primary" variant="flat">
                        链接 #{index + 1}
                      </Chip>
                      <Chip variant="flat">
                        {SUPPORTED_RESOURCE_LINK_MAP[link.storage] ??
                          link.storage}
                      </Chip>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <Input
                        id={`${groupId}-content`}
                        label="资源链接"
                        value={link.content}
                        onValueChange={(content) =>
                          updateLink(index, { content })
                        }
                        isRequired={canEdit('content')}
                        isReadOnly={!canEdit('content')}
                        description={
                          link.storage === 's3'
                            ? '对象存储的链接与大小由系统生成, 无法修改'
                            : !canEdit('content')
                              ? 'TouchGal 资源盘的链接仅管理员可修改'
                              : undefined
                        }
                        maxLength={1007}
                        isInvalid={!!errors?.content}
                        errorMessage={errors?.content}
                      />
                      <Input
                        id={`${groupId}-size`}
                        label="大小 (MB 或 GB)"
                        value={link.size}
                        onValueChange={(size) => updateLink(index, { size })}
                        isRequired={canEdit('size')}
                        isReadOnly={!canEdit('size')}
                        maxLength={109}
                        isInvalid={!!errors?.size}
                        errorMessage={errors?.size}
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <Input
                        label="提取码"
                        value={link.code}
                        onValueChange={(code) => updateLink(index, { code })}
                        isReadOnly={!canEdit('code')}
                        maxLength={1007}
                      />
                      <Input
                        label="解压码"
                        value={link.password}
                        onValueChange={(password) =>
                          updateLink(index, { password })
                        }
                        isReadOnly={!canEdit('password')}
                        maxLength={1007}
                      />
                    </div>
                  </CardBody>
                </Card>
              )
            })}
          </div>
        </div>
      </ModalBody>

      <ModalFooter>
        <Button color="danger" variant="light" onPress={onClose}>
          取消
        </Button>
        {submitButton}
      </ModalFooter>
    </ModalContent>
  )
}
