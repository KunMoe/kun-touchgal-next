'use client'

import {
  Alert,
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
  Spinner,
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
import { errorReporter } from '~/utils/kunErrorHandler'
import toast from 'react-hot-toast'
import type { CampaignTemplateId } from '~/constants/email/campaign'

const emptyVars = { title: '', content: '' }

export const EmailTemplate = () => {
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

  // 与实际发出的邮件是同一个函数的输出; 预览里没有收件人, 退订链接用落地页占位
  const previewContent = selectedTemplate
    ? renderCampaignEmail(
        selectedTemplate,
        { titleHtml: templateVars.title, contentHtml: templateVars.content },
        kunUnsubscribePageUrl()
      ).html
    : ''

  const handleSendEmails = async () => {
    if (!selectedTemplate) {
      return
    }

    setIsSending(true)
    try {
      const response = await kunFetchPost<
        KunResponse<{ count: number; failed: number }>
      >('/admin/mail', {
        templateId: selectedTemplate,
        variables: templateVars
      })
      if (typeof response === 'string') {
        // 请求失败时保留已选的模板与变量, 弹窗不关
        toast.error(response)
        return
      } else if (response.failed > 0) {
        toast.error(
          `向网站的 ${response.count} 位用户发送邮件, 其中 ${response.failed} 封发送失败`
        )
      } else {
        toast.success(`已经向网站的 ${response.count} 位用户发送了邮件`)
      }
      setSelectedTemplate('')
      setTemplateVars(emptyVars)
      onClose()
    } catch (error) {
      errorReporter(error)
    } finally {
      setIsSending(false)
    }
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
              onChange={(e) =>
                setTemplateVars({ ...templateVars, title: e.target.value })
              }
            />
            <Textarea
              label="内容"
              placeholder="请输入您的内容"
              value={templateVars.content}
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
            {isSending && (
              <Alert
                title="正在发送中"
                description="正在为网站全体用户发送邮件, 发送时间取决于网站的用户数量,
            以及邮件服务的网络状况, 请等待"
                icon={<Spinner />}
                color="primary"
                variant="faded"
              />
            )}
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
