'use client'

import { Card, CardBody, CardFooter, Divider, Switch } from '@heroui/react'
import { useState } from 'react'
import { FlaskConical, ShieldCheck } from 'lucide-react'
import { kunFetchPut } from '~/utils/kunFetch'
import { errorReporter } from '~/utils/kunErrorHandler'
import toast from 'react-hot-toast'

interface Props {
  enabled: boolean
  dryRun: boolean
}

export const ModerationSetting = ({ enabled, dryRun }: Props) => {
  const [isEnabled, setIsEnabled] = useState(enabled)
  const [isDryRun, setIsDryRun] = useState(dryRun)
  const [isSaving, setIsSaving] = useState(false)

  const handleSwitch = async (value: { enabled: boolean; dryRun: boolean }) => {
    setIsSaving(true)
    try {
      const res = await kunFetchPut<KunResponse<{}>>(
        '/admin/setting/moderation',
        value
      )
      if (typeof res === 'string') {
        toast.error(res)
      } else {
        setIsEnabled(value.enabled)
        setIsDryRun(value.dryRun)
        toast.success('应用设置成功')
      }
    } catch (error) {
      errorReporter(error)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">AI 内容审核</h3>
              <p className="text-small text-default-500">
                开启后，评论、评价、资源、头像、签名将先由 AI
                审核，通过后才对他人可见
              </p>
            </div>
            <Switch
              isSelected={isEnabled}
              onValueChange={(value) =>
                handleSwitch({ enabled: value, dryRun: isDryRun })
              }
              isDisabled={isSaving}
              size="lg"
              color="primary"
              startContent={<ShieldCheck className="w-4 h-4" />}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">灰度模式 (Dry Run)</h3>
              <p className="text-small text-default-500">
                照常送审并记录 AI 裁决，但不拦截任何内容，用于上线前校准误杀率
              </p>
            </div>
            <Switch
              isSelected={isDryRun}
              onValueChange={(value) =>
                handleSwitch({ enabled: isEnabled, dryRun: value })
              }
              isDisabled={isSaving}
              size="lg"
              color="warning"
              startContent={<FlaskConical className="w-4 h-4" />}
            />
          </div>
        </CardBody>
        <Divider />
        <CardFooter className="text-sm text-default-500">
          设置最多 30 秒内在所有实例生效；关闭审核不影响已在队列中的任务
        </CardFooter>
      </Card>
    </div>
  )
}
