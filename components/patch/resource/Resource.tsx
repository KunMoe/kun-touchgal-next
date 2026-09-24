'use client'

import { useEffect, useLayoutEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  Alert,
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/react'
import { Plus } from 'lucide-react'
import { kunFetchDelete, kunFetchGet } from '~/utils/kunFetch'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { ResourceTabs } from './Tabs'
import { KunLoading } from '~/components/kun/Loading'
import { LazyDialogFallback } from '~/components/patch/header/LazyDialogFallback'
import { useUserStore } from '~/store/userStore'
import toast from 'react-hot-toast'
import type { PatchResource } from '~/types/api/patch'

// 发布 / 编辑表单连带 zod / RHF / Select / 上传与人机验证, 只有发布者和作者 / 管理员
// 用得到; 静态导入会让每位打开资源 tab 的访客在资源列表出现前多下约 107KB gz.
// Modal 关闭时不渲染 children, 故首次打开才开始加载
const PublishResource = dynamic(
  () => import('./publish/PublishResource').then((m) => m.PublishResource),
  {
    ssr: false,
    loading: () => <LazyDialogFallback hint="正在加载发布表单..." />
  }
)

const EditResourceDialog = dynamic(
  () => import('./edit/EditResourceDialog').then((m) => m.EditResourceDialog),
  {
    ssr: false,
    loading: () => <LazyDialogFallback hint="正在加载编辑器..." />
  }
)

const preloadPublishResource = () => {
  void import('./publish/PublishResource')
}

interface Props {
  id: number
  vndbId: string
  onLoaded?: () => void
}

export const Resources = ({ id, vndbId, onLoaded }: Props) => {
  // 初值为 true: 否则挂载首帧会把空列表画成「本游戏暂无」并预加载 null.webp
  const [loading, setLoading] = useState(true)
  const [resources, setResources] = useState<PatchResource[]>([])
  const uid = useUserStore((state) => state.user.uid)

  // 用 layout effect: 先于 ResourceTabs 定位卡片的 passive effect 执行, 深链带
  // resourceId 且卡片存在时, 父组件滚到 tabs 的平滑滚动会被随后滚到卡片的那次覆盖
  useLayoutEffect(() => {
    if (!loading) {
      onLoaded?.()
    }
  }, [loading])

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true)
      try {
        const res = await kunFetchGet<KunResponse<PatchResource[]>>(
          '/patch/resource',
          { patchId: Number(id) }
        )
        kunErrorHandler(res, setResources)
      } catch {
        toast.error('获取资源列表失败, 请稍后重试')
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  const {
    isOpen: isOpenCreate,
    onOpen: onOpenCreate,
    onClose: onCloseCreate
  } = useDisclosure()

  const {
    isOpen: isOpenEdit,
    onOpen: onOpenEdit,
    onClose: onCloseEdit
  } = useDisclosure()
  const [editResource, setEditResource] = useState<PatchResource | null>(null)

  const {
    isOpen: isOpenDelete,
    onOpen: onOpenDelete,
    onClose: onCloseDelete
  } = useDisclosure()
  const [deleteResourceId, setDeleteResourceId] = useState(0)
  const [deleting, setDeleting] = useState(false)
  const handleDeleteResource = async () => {
    setDeleting(true)
    try {
      const res = await kunFetchDelete<KunResponse<{}>>('/patch/resource', {
        resourceId: deleteResourceId
      })
      kunErrorHandler(res, () => {
        setResources((prev) =>
          prev.filter((resource) => resource.id !== deleteResourceId)
        )
        setDeleteResourceId(0)
        onCloseDelete()
        toast.success('删除资源链接成功')
      })
    } catch {
      toast.error('删除资源链接失败, 请稍后重试')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="mt-4 space-y-4">
      {uid > 0 && (
        <div className="flex justify-end">
          <Button
            color="primary"
            variant="flat"
            startContent={<Plus className="size-4" />}
            onPress={onOpenCreate}
            onPointerEnter={preloadPublishResource}
            onFocus={preloadPublishResource}
          >
            添加资源
          </Button>
        </div>
      )}

      {loading ? (
        <KunLoading hint="正在获取 Galgame 资源数据..." />
      ) : (
        <ResourceTabs
          vndbId={vndbId}
          resources={resources}
          setEditResource={setEditResource}
          onOpenEdit={onOpenEdit}
          onOpenDelete={onOpenDelete}
          setDeleteResourceId={setDeleteResourceId}
        />
      )}

      <Modal
        size="3xl"
        isOpen={isOpenCreate}
        onClose={onCloseCreate}
        scrollBehavior="outside"
        isDismissable={false}
        isKeyboardDismissDisabled={true}
      >
        <PublishResource
          patchId={id}
          onClose={onCloseCreate}
          onSuccess={(res) => {
            setResources([...resources, res])
            onCloseCreate()
          }}
        />
      </Modal>

      <Modal
        size="3xl"
        isOpen={isOpenEdit}
        onClose={onCloseEdit}
        scrollBehavior="outside"
        isDismissable={false}
        isKeyboardDismissDisabled={true}
      >
        <EditResourceDialog
          onClose={onCloseEdit}
          resource={editResource!}
          onSuccess={(res) => {
            setResources((prevResources) =>
              prevResources.map((resource) =>
                resource.id === res.id ? res : resource
              )
            )
            onCloseEdit()
          }}
        />
      </Modal>

      <Modal isOpen={isOpenDelete} onClose={onCloseDelete} placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            删除资源链接
          </ModalHeader>
          <ModalBody>
            <p>
              您确定要删除这条资源链接吗,
              这将会导致您发布资源链接获得的萌萌点被扣除, 该操作不可撤销
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onCloseDelete}>
              取消
            </Button>
            <Button
              color="danger"
              onPress={handleDeleteResource}
              disabled={deleting}
              isLoading={deleting}
            >
              删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  )
}
