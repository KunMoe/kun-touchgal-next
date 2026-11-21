'use client'

import {
  Button,
  Card,
  CardBody,
  Input,
  Link,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Radio,
  RadioGroup,
  Textarea,
  useDisclosure
} from '@heroui/react'
import { useState } from 'react'
import { Mail } from 'lucide-react'
import {
  CAMPAIGN_TEMPLATE_IDS,
  CAMPAIGN_TEMPLATES,
  isCampaignTemplateId,
  kunUnsubscribePageUrl,
  renderCampaignEmail
} from '~/constants/email/campaign'
import { EmailPreview } from './EmailPreview'
import { kunFetchPost } from '~/utils/kunFetch'
import {
  MAIL_CAMPAIGN_CONTENT_LIMIT,
  MAIL_CAMPAIGN_TITLE_LIMIT
} from '~/constants/admin'
import toast from 'react-hot-toast'
import type { CampaignTemplateId } from '~/constants/email/campaign'

const emptyVars = { title: '', content: '' }

interface Props {
  // 建任务的请求有了结果 (无论成败) 就通知父组件, 让进度列表重读: 被拒绝往往是因为
  // 已有任务在进行, 而这个页面打开时它还不存在
  onSubmitted: () => void
}

export const EmailTemplate = ({ onSubmitted }: Props) => {
  const [selectedTemplate, setSelectedTemplate] = useState<
    CampaignTemplateId | ''
  >('')
  const [templateVars, setTemplateVars] = useState(emptyVars)
  const [isSending, setIsSending] = useState(false)
  const { isOpen, onOpen, onClose } = useDisclosure()

  const handleTemplateChange = (value: string) => {
    if (!isCampaignTemplateId(value)) {
      return
    }
    setSelectedTemplate(value)
    setTemplateVars(emptyVars)
  }

  // 与实际发出的邮件是同一个函数的输出 (服务端会去掉标题与正文首尾的空白, 这里照做);
  // 预览里没有收件人, 退订链接用落地页占位
  const previewContent = selectedTemplate
    ? renderCampaignEmail(
        selectedTemplate,
        {
          titleHtml: templateVars.title.trim(),
          contentHtml: templateVars.content.trim()
        },
        kunUnsubscribePageUrl()
      ).html
    : ''

  const handleSendEmails = async () => {
    if (!selectedTemplate) {
      return
    }

    setIsSending(true)
    // 这个请求只建任务, 邮件由定时任务在后台分批发出
    const response = await kunFetchPost<KunResponse<{ campaignId: number }>>(
      '/admin/mail',
      { templateId: selectedTemplate, variables: templateVars }
    )
    setIsSending(false)
    onSubmitted()
    if (typeof response === 'string') {
      // 请求失败时保留已选的模板与变量, 弹窗不关
      toast.error(response)
      return
    }
    toast.success(
      `群发任务 #${response.campaignId} 已创建, 邮件会在后台分批发出`
    )
    setSelectedTemplate('')
    setTemplateVars(emptyVars)
    onClose()
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-6">
          <div>
            <h3 className="text-lg font-semibold">群发邮件</h3>
            <p className="text-small text-default-500">给所有用户发送邮件</p>
          </div>

          <RadioGroup
            label="请选择邮件模板"
            value={selectedTemplate}
            onValueChange={handleTemplateChange}
          >
            {CAMPAIGN_TEMPLATE_IDS.map((id) => (
              <Radio key={id} value={id}>
                {CAMPAIGN_TEMPLATES[id].name}
              </Radio>
            ))}
          </RadioGroup>

          <>
            <Input
              label="标题"
              placeholder="请输入您的标题"
              value={templateVars.title}
              maxLength={MAIL_CAMPAIGN_TITLE_LIMIT}
              onChange={(e) =>
                setTemplateVars({ ...templateVars, title: e.target.value })
              }
            />
            <Textarea
              label="内容"
              placeholder="请输入您的内容"
              value={templateVars.content}
              maxLength={MAIL_CAMPAIGN_CONTENT_LIMIT}
              onChange={(e) =>
                setTemplateVars({ ...templateVars, content: e.target.value })
              }
              minRows={4}
            />
            <p className="text-sm">
              内容支持 HTML, 可以使用{' '}
              <Link
                isExternal
                showAnchorIcon
                href="https://www.wangeditor.com/demo/get-html.html"
              >
                wangEditor
              </Link>
              进行编辑, 编辑完成后复制下方输出的 HTML 即可
            </p>
          </>

          <div className="flex justify-end">
            <Button
              color="secondary"
              endContent={<Mail className="w-4 h-4" />}
              onPress={onOpen}
              isDisabled={
                !selectedTemplate ||
                !templateVars.title.trim() ||
                !templateVars.content.trim()
              }
            >
              向全体用户发送
            </Button>
          </div>
        </CardBody>
      </Card>

      <Modal isOpen={isOpen} onClose={onClose}>
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            您确定要向全体用户发送下面的邮件吗?
          </ModalHeader>
          <ModalBody>
            <EmailPreview content={previewContent} previewOnly={true} />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onClose}>
              取消
            </Button>
            <Button
              color="primary"
              onPress={handleSendEmails}
              isDisabled={isSending}
              isLoading={isSending}
            >
              发送
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <EmailPreview content={previewContent} />
    </div>
  )
}
