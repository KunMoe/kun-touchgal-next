'use client'

import { useRef } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from '@bprogress/next/app'
import { useSearchParams } from 'next/navigation'
import { Button } from '@heroui/button'
import { Card, CardBody, CardHeader } from '@heroui/card'
import { Chip } from '@heroui/chip'
import { Modal, useDisclosure } from '@heroui/modal'
import { Tooltip } from '@heroui/tooltip'
import { Clock, Download, Edit2 } from 'lucide-react'
import { KunPatchAttribute } from '~/components/kun/PatchAttribute'
import { KunUser } from '~/components/kun/floating-card/KunUser'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { KunAutoImageViewer } from '~/components/kun/image-viewer/AutoImageViewer'
import { ResourceLikeButton } from '~/components/patch/resource/ResourceLike'
import { UserFollow } from '~/components/user/follow/Follow'
import { ResourceDownloadCard } from '~/components/patch/resource/DownloadCard'
import { useUserStore } from '~/store/userStore'
import { useKunExternalLinkNavigation } from '~/components/kun/external-link/useKunExternalLinkNavigation'
import { KunNull } from '~/components/kun/Null'
import { LazyDialogFallback } from '~/components/patch/header/LazyDialogFallback'
import { GalgameSummaryCard } from './GalgameSummaryCard'
import { OtherResources } from './OtherResources'
import { getResourcePageTitle } from '~/utils/patch/getResourcePageTitle'
import { parseDeepLinkId } from '~/utils/patch/parseDeepLinkId'
import { formatNumber } from '~/utils/formatNumber'
import { cn } from '~/utils/cn'
import { kunCjkIndentClass } from '~/utils/kunCjkIndent'
import type { PatchResourceDetail } from '~/app/api/patch/resource/detail'

// 编辑表单连带 zod 全量 / RHF / Select / 上传, 只有上传者和管理员用得到,
// 静态导入会让每位访客首屏多下约 150KB gz
const EditResourceDialog = dynamic(
  () =>
    import('~/components/patch/resource/edit/EditResourceDialog').then(
      (m) => m.EditResourceDialog
    ),
  {
    ssr: false,
    loading: () => <LazyDialogFallback hint="正在加载编辑器..." />
  }
)

const preloadEditResourceDialog = () => {
  void import('~/components/patch/resource/edit/EditResourceDialog')
}

// 游客由下方直接给占位, 不下发评论块; 登录用户 SSR 时低优先级 preload.
// loading 承重: next/dynamic 在 ssr:true 且无 loading 时不包 Suspense,
// 评论块未到会挂起外层边界, 拖住整个详情页的水合
const Comments = dynamic(
  () => import('~/components/patch/comment/Comments').then((m) => m.Comments),
  { loading: () => <KunNull message="加载中..." /> }
)

interface Props {
  detail: PatchResourceDetail
  isLoggedIn: boolean
}

export const ResourceDetail = ({ detail, isLoggedIn }: Props) => {
  const { resource, galgame, otherResources } = detail
  const isPending = resource.status === 2 || resource.status === 3
  const pageTitle = getResourcePageTitle(resource)
  const mainColumnRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const searchParams = useSearchParams()
  const user = useUserStore((state) => state.user)
  const isAdmin = user.role > 2
  const canEdit = isAdmin || user.uid === resource.userId
  // 待审核资源后端只放行 role >= 3 (patch/resource/update.ts 的 status 闸门整段
  // 挂在 userRole < 3 下), 作者本人提交必被拒, 故置灰而非让他点了才看到报错
  const isEditDisabled = isPending && !isAdmin
  const {
    isOpen: isOpenEdit,
    onOpen: onOpenEdit,
    onClose: onCloseEdit
  } = useDisclosure()

  useKunExternalLinkNavigation(noteRef, resource.noteHtml)

  return (
    <div className="w-full mx-auto max-w-7xl space-y-6">
      {/* 与游戏详情页同一套 document 级图片灯箱: 评论与资源简介里的
          markdown 图片点击后开灯箱, 挂载点决定作用域故必须留在页面内 */}
      <KunAutoImageViewer />

      <GalgameSummaryCard galgame={galgame} />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div ref={mainColumnRef} className="min-w-0 space-y-6">
          <Card>
            <CardBody className="flex flex-col gap-4 p-6">
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <h1
                      className={cn(
                        'text-2xl font-bold',
                        kunCjkIndentClass(pageTitle)
                      )}
                    >
                      {pageTitle}
                    </h1>
                    {isPending && (
                      <Tooltip content="审核中，仅你和管理员可见">
                        <Chip color="warning" variant="flat" size="sm">
                          待审核
                        </Chip>
                      </Tooltip>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {canEdit && (
                      <Tooltip content="编辑资源" placement="bottom">
                        <Button
                          isIconOnly
                          aria-label="编辑资源"
                          variant="light"
                          isDisabled={isEditDisabled}
                          onPress={onOpenEdit}
                          onPointerEnter={preloadEditResourceDialog}
                          onFocus={preloadEditResourceDialog}
                        >
                          <Edit2 className="size-4" />
                        </Button>
                      </Tooltip>
                    )}
                    <ResourceLikeButton
                      resource={resource}
                      isDisabled={isPending}
                    />
                  </div>
                </div>

                <KunPatchAttribute
                  types={resource.type}
                  languages={resource.language}
                  platforms={resource.platform}
                  emulatorType={resource.emulatorType}
                  modelName={resource.modelName}
                  size="sm"
                />

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-default-500">
                  <span className="flex items-center gap-1">
                    <Clock className="size-4" />
                    发布于{' '}
                    <KunTimeAgo date={resource.created} maxRelativeDays={7} />
                  </span>
                  <span className="flex items-center gap-1" title="下载数">
                    <Download className="size-4" />
                    {formatNumber(resource.download)}
                  </span>
                </div>
              </div>

              {resource.note && (
                <Card shadow="none" className="border border-default-200">
                  <CardBody>
                    <div
                      ref={noteRef}
                      className="kun-prose kun-prose-compact max-w-none"
                      dangerouslySetInnerHTML={{ __html: resource.noteHtml }}
                    />
                  </CardBody>
                </Card>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex-col items-start">
              <h2 className="text-lg font-semibold">下载链接</h2>
              <p className="text-sm text-default-500">
                使用资源前请认真阅读资源简介, 以免产生问题
              </p>
            </CardHeader>
            <CardBody className="space-y-3">
              {resource.links.length > 0 ? (
                resource.links.map((link) => (
                  <Card
                    key={link.id}
                    shadow="none"
                    className="border border-default-200"
                  >
                    <CardBody>
                      <ResourceDownloadCard resource={resource} link={link} />
                    </CardBody>
                  </Card>
                ))
              ) : (
                <p className="text-sm text-default-500">该资源暂无下载链接</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex-col items-start">
              <h2 className="text-lg font-semibold">资源评论</h2>
              <p className="text-sm text-default-500">
                您可以在这里发表关于本资源的评论或反馈，资源作者将会收到通知
              </p>
            </CardHeader>
            <CardBody>
              {isLoggedIn ? (
                <Comments
                  id={resource.patchId}
                  resourceId={resource.id}
                  targetCommentId={parseDeepLinkId(
                    searchParams.get('commentId')
                  )}
                />
              ) : (
                <KunNull message="请登录后查看评论" />
              )}
            </CardBody>
          </Card>
        </div>

        <aside className="min-w-0 space-y-6">
          <Card>
            <CardBody className="flex-row items-center justify-between gap-2 p-4">
              <KunUser
                user={resource.user}
                userProps={{
                  name: resource.user.name,
                  description: `已发布资源 ${resource.user.patchCount} 个`,
                  avatarProps: {
                    showFallback: true,
                    src: resource.user.avatar,
                    name: resource.user.name.charAt(0).toUpperCase()
                  }
                }}
              />
              <UserFollow
                uid={resource.user.id}
                name={resource.user.name}
                follow={detail.isFollowingUploader}
                fullWidth={false}
                size="sm"
              />
            </CardBody>
          </Card>

          <OtherResources
            resources={otherResources}
            patchUniqueId={resource.uniqueId}
            mainColumnRef={mainColumnRef}
          />
        </aside>
      </div>

      {canEdit && (
        <Modal
          size="3xl"
          isOpen={isOpenEdit}
          onClose={onCloseEdit}
          scrollBehavior="outside"
          isDismissable={false}
          isKeyboardDismissDisabled={true}
        >
          {/* 关闭即卸载, 每次打开都以最新的 detail.resource 作表单初值;
              保存后走 router.refresh() 而非回写接口返回值 —— PUT 的响应体
              把 likeCount/isLike 硬编码为 0/false, 直接采信会清空点赞展示 */}
          <EditResourceDialog
            resource={resource}
            onClose={onCloseEdit}
            onSuccess={() => {
              onCloseEdit()
              router.refresh()
            }}
          />
        </Modal>
      )}
    </div>
  )
}
