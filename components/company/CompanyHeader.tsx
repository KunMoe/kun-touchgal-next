'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Button } from '@heroui/button'
import { useDisclosure } from '@heroui/modal'
import { Plus } from 'lucide-react'
import { KunHeader } from '../kun/Header'
import { LazyDialogFallback } from '~/components/patch/header/LazyDialogFallback'
import { useUserStore } from '~/store/userStore'
import type { FC } from 'react'
import type { Company as CompanyType } from '~/types/api/company'

// 表单连带 zod 全量 / RHF / Select, 只有管理员用得到, 静态导入会让每位访客
// 首屏多下约 130KB gz. 首次打开后保持挂载, 保留关闭动画
const CompanyFormModal = dynamic(
  () => import('./form/CompanyFormModal').then((m) => m.CompanyFormModal),
  { ssr: false, loading: () => <LazyDialogFallback hint="正在加载表单..." /> }
)

const preloadCompanyFormModal = () => {
  void import('./form/CompanyFormModal')
}

interface Props {
  setNewCompany: (company: CompanyType) => void
}

export const CompanyHeader: FC<Props> = ({ setNewCompany }) => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const user = useUserStore((state) => state.user)
  const [hasOpened, setHasOpened] = useState(false)

  return (
    <>
      <KunHeader
        name="会社列表"
        description="这里是本站 Galgame 中包含的所有会社"
        headerEndContent={
          <>
            {user.role > 2 && (
              <Button
                color="primary"
                onPress={() => {
                  setHasOpened(true)
                  onOpen()
                }}
                onPointerEnter={preloadCompanyFormModal}
                onFocus={preloadCompanyFormModal}
                startContent={<Plus />}
              >
                创建会社
              </Button>
            )}
          </>
        }
      />

      {hasOpened && (
        <CompanyFormModal
          type="create"
          isOpen={isOpen}
          onClose={onClose}
          onSuccess={(newCompany) => {
            setNewCompany(newCompany)
            onClose()
          }}
        />
      )}
    </>
  )
}
