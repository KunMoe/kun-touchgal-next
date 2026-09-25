'use client'

import { useEffect, useRef, useState } from 'react'
import type { MouseEvent, PointerEvent } from 'react'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  Chip,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Tooltip,
  User,
  Tab,
  Tabs
} from '@heroui/react'
import { Edit, MoreHorizontal, Trash2 } from 'lucide-react'
import { useUserStore } from '~/store/userStore'
import { ResourceInfo } from './ResourceInfo'
import { ResourceDownload } from './ResourceDownload'
import {
  RESOURCE_SECTION_MAP,
  SUPPORTED_RESOURCE_SECTION
} from '~/constants/resource'
import { KunResourceInfo } from './kun/KunResourceInfo'
import { KunResourceDownload } from './kun/KunResourceDownload'
import { KunLoading } from '~/components/kun/Loading'
import { KunNull } from '~/components/kun/Null'
import { kunFetchGet } from '~/utils/kunFetch'
import { useKunNextRouter } from '~/components/kun/KunRouterProvider'
import type { PatchResource } from '~/types/api/patch'
import type { KunMoyuPatchResource } from '~/types/api/kun/moyu-moe'
import Link from 'next/link'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { cn } from '~/utils/cn'
import { kunCjkIndentClass } from '~/utils/kunCjkIndent'

type ResourceSection = (typeof SUPPORTED_RESOURCE_SECTION)[number]

// 编辑表单在 Resource.tsx 里是懒加载的, 打开操作菜单时先预热
const preloadEditResourceDialog = () => {
  void import('./edit/EditResourceDialog')
}

interface Props {
  vndbId: string
  resources: PatchResource[]
  setEditResource: (resources: PatchResource) => void
  onOpenEdit: () => void
  onOpenDelete: () => void
  setDeleteResourceId: (resourceId: number) => void
  targetResourceId: number | null
  targetResourceSection: ResourceSection | null
}

export const ResourceTabs = ({
  vndbId,
  resources,
  setEditResource,
  onOpenEdit,
  onOpenDelete,
  setDeleteResourceId,
  targetResourceId,
  targetResourceSection
}: Props) => {
  const router = useKunNextRouter()
  const user = useUserStore((state) => state.user)
  const [selectedSection, setSelectedSection] =
    useState<ResourceSection>('galgame')
  const [highlightedResourceId, setHighlightedResourceId] = useState<
    number | null
  >(null)

  const [kunResources, setKunResources] = useState<KunMoyuPatchResource[]>([])
  const [kunLoading, setKunLoading] = useState(false)
  const [kunLoaded, setKunLoaded] = useState(false)
  // 深链目标只定位一次: tab 保活后目标会一直留在 props 里, 不设防的话之后每次增删改
  // 资源或切分区, 都会把用户拽回目标分区 / 目标卡片
  const locatedSectionTargetRef = useRef<string | null>(null)
  const scrolledResourceIdRef = useRef<number | null>(null)

  useEffect(() => {
    const targetKey = `${targetResourceSection}:${targetResourceId}`
    if (locatedSectionTargetRef.current === targetKey) {
      return
    }

    if (targetResourceSection) {
      locatedSectionTargetRef.current = targetKey
      setSelectedSection(targetResourceSection)
      return
    }

    if (!targetResourceId) {
      return
    }

    const targetResource = resources.find(
      (resource) => resource.id === targetResourceId
    )
    if (targetResource) {
      locatedSectionTargetRef.current = targetKey
      setSelectedSection(targetResource.section as ResourceSection)
    }
  }, [resources, targetResourceId, targetResourceSection])

  const fetchKunPatchData = async () => {
    if (!vndbId || kunLoaded) {
      return
    }

    try {
      setKunLoading(true)
      const response = await kunFetchGet<KunMoyuPatchResource[] | string>(
        '/patch/moyu',
        { vndbId }
      )
      setKunResources(typeof response === 'string' ? [] : response)
    } catch {
      setKunResources([])
    } finally {
      setKunLoading(false)
      setKunLoaded(true)
    }
  }

  useEffect(() => {
    if (selectedSection === 'patch') {
      fetchKunPatchData()
    }
  }, [selectedSection])

  useEffect(() => {
    if (
      !targetResourceId ||
      scrolledResourceIdRef.current === targetResourceId
    ) {
      return
    }

    const targetElement = document.getElementById(
      `resource-${targetResourceId}`
    )
    if (!targetElement) {
      return
    }

    scrolledResourceIdRef.current = targetResourceId
    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightedResourceId(targetResourceId)
  }, [resources, selectedSection, targetResourceId])

  // 高亮计时独立于定位 effect: 后者重跑时会提前返回, 不能靠它的 cleanup 清计时器
  useEffect(() => {
    if (highlightedResourceId === null) {
      return
    }

    const timer = window.setTimeout(() => setHighlightedResourceId(null), 3000)
    return () => window.clearTimeout(timer)
  }, [highlightedResourceId])

  const categorizedResources = SUPPORTED_RESOURCE_SECTION.reduce(
    (acc, section) => {
      acc[section] = resources.filter((r) => r.section === section)
      return acc
    },
    {} as Record<ResourceSection, PatchResource[]>
  )

  // 整卡可点击进入资源详情页; 链接/按钮等交互元素的点击不触发导航
  // 修饰键点击交给卡内资源名链接的原生语义 (新标签页等), 不劫持当前页
  const isNavigationBlocked = (event: MouseEvent<HTMLDivElement>) =>
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    !!(event.target as HTMLElement).closest('a, button, [role="button"]')

  const handleResourceCardClick = (
    event: MouseEvent<HTMLDivElement>,
    resource: PatchResource
  ) => {
    if (isNavigationBlocked(event)) {
      return
    }
    // 框选文字松手时 click 会派发到共同祖先 (本卡片), 不应触发导航
    if (window.getSelection()?.toString()) {
      return
    }
    router.push(`/${resource.uniqueId}/resource/${resource.id}`)
  }

  // 按压态直接写在卡片 DOM 上而不放 state: 放在本组件顶层时, 按下和抬起
  // 各会让当前分区的整张卡片列表重渲染一次
  const clearPressed = (event: PointerEvent<HTMLDivElement>) =>
    event.currentTarget.removeAttribute('data-pressed')

  // 按压缩放动画参考首页 GalgameCard (isPressable), 缩放幅度更轻 (0.99);
  // 只在会触发整卡导航的按压上出现, 点卡内交互元素不缩放
  const renderResourceCard = (resource: PatchResource) => (
    <div
      key={resource.id}
      id={`resource-${resource.id}`}
      className={cn(
        'group/resource-card cursor-pointer border p-3 rounded-2xl border-default-200 transition tap-highlight-transparent hover:border-primary-400 data-[pressed]:scale-[0.99]',
        highlightedResourceId === resource.id &&
          'ring-2 ring-primary ring-offset-2 ring-offset-background'
      )}
      onClick={(event) => handleResourceCardClick(event, resource)}
      onPointerDown={(event) => {
        if (!isNavigationBlocked(event)) {
          event.currentTarget.setAttribute('data-pressed', '')
        }
      }}
      onPointerUp={clearPressed}
      onPointerLeave={clearPressed}
      onPointerCancel={clearPressed}
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            {resource.name && (
              <h3
                className={cn('font-medium', kunCjkIndentClass(resource.name))}
              >
                <Link
                  href={`/${resource.uniqueId}/resource/${resource.id}`}
                  className="transition-colors group-hover/resource-card:text-primary"
                >
                  {resource.name}
                </Link>
              </h3>
            )}
            <ResourceInfo resource={resource} />
            {(resource.status === 2 || resource.status === 3) && (
              <Tooltip content="审核中，仅你和管理员可见">
                <Chip color="warning" variant="flat" size="sm">
                  待审核
                </Chip>
              </Tooltip>
            )}
          </div>
          <Dropdown
            onOpenChange={(isOpen) => {
              if (isOpen && user.uid > 0) {
                preloadEditResourceDialog()
              }
            }}
          >
            <DropdownTrigger>
              <Button variant="light" isIconOnly size="sm">
                <MoreHorizontal aria-label="资源操作" className="size-4" />
              </Button>
            </DropdownTrigger>
            <DropdownMenu
              aria-label="Resource actions"
              disabledKeys={
                resource.status === 2 || resource.status === 3
                  ? ['edit', 'delete']
                  : user.uid !== resource.userId && user.role < 3
                    ? ['edit', 'delete']
                    : []
              }
            >
              <DropdownItem
                key="edit"
                startContent={<Edit className="size-4" />}
                onPress={() => {
                  setEditResource(resource)
                  onOpenEdit()
                }}
              >
                编辑
              </DropdownItem>
              <DropdownItem
                key="delete"
                className="text-danger"
                color="danger"
                startContent={<Trash2 className="size-4" />}
                onPress={() => {
                  setDeleteResourceId(resource.id)
                  onOpenDelete()
                }}
              >
                删除
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>
        </div>
        <ResourceDownload resource={resource} />
      </div>
    </div>
  )

  return (
    <Tabs
      selectedKey={selectedSection}
      onSelectionChange={(key) => setSelectedSection(key as ResourceSection)}
      className="mb-4"
    >
      {SUPPORTED_RESOURCE_SECTION.map((section) => {
        const sectionResources = categorizedResources[section]
        const official = sectionResources.filter((r) => r.user?.role > 2)
        const community = sectionResources.filter((r) => !(r.user?.role > 2))

        return (
          <Tab
            key={section}
            title={RESOURCE_SECTION_MAP[section]}
            className="w-full"
          >
            <div className="space-y-6">
              {official.length > 0 && (
                <Card>
                  <CardHeader>
                    <Link href="/">
                      <User
                        avatarProps={{
                          src: '/logo.webp',
                          radius: 'none',
                          classNames: {
                            base: 'bg-transparent'
                          }
                        }}
                        description={`${kunMoyuMoe.titleShort} 官方提供的 Galgame 下载资源`}
                        name={`${kunMoyuMoe.titleShort} 官方 (推荐下载)`}
                      />
                    </Link>
                  </CardHeader>
                  <CardBody className="space-y-2 gap-3">
                    {official.map((res) => renderResourceCard(res))}
                  </CardBody>
                </Card>
              )}

              {community.length > 0 && (
                <Card>
                  <CardHeader>
                    <Link target="_blank" href={kunMoyuMoe.domain.forum}>
                      <User
                        avatarProps={{
                          src: '/sooner/琥珀.webp',
                          classNames: {
                            base: 'bg-transparent'
                          }
                        }}
                        description={`来自 ${kunMoyuMoe.titleShort} 用户自行发布的下载资源`}
                        name={`${kunMoyuMoe.titleShort} 社区下载资源`}
                      />
                    </Link>
                  </CardHeader>
                  <CardBody className="space-y-3">
                    {community.map((res) => renderResourceCard(res))}
                  </CardBody>
                </Card>
              )}

              {section === 'patch' && (
                <Card>
                  <CardHeader>
                    <Link target="_blank" href="https://www.moyu.moe/">
                      <User
                        avatarProps={{
                          src: '/moyu-moe.webp',
                          classNames: {
                            base: 'bg-transparent'
                          }
                        }}
                        description="来自鲲 Galgame 补丁的补丁下载资源"
                        name="鲲 Galgame 补丁"
                      />
                    </Link>
                  </CardHeader>
                  <CardBody className="space-y-3">
                    {kunLoading ? (
                      <KunLoading hint="正在加载鲲 Galgame 补丁..." />
                    ) : kunResources.length > 0 ? (
                      <>
                        {kunResources.map((resource) => (
                          <div
                            key={resource.id}
                            className="border p-3 rounded-2xl border-default-200"
                          >
                            <div className="space-y-2">
                              <KunResourceInfo resource={resource} />
                              <KunResourceDownload resource={resource} />
                            </div>
                          </div>
                        ))}
                      </>
                    ) : (
                      (!vndbId || kunLoaded) && (
                        <KunNull message="本游戏在鲲 Galgame 补丁暂无对应补丁" />
                      )
                    )}
                  </CardBody>
                </Card>
              )}

              {section !== 'patch' &&
                official.length === 0 &&
                community.length === 0 && (
                  <KunNull
                    message={`本游戏暂无 ${RESOURCE_SECTION_MAP[section]}`}
                  />
                )}
            </div>
          </Tab>
        )
      })}
    </Tabs>
  )
}
