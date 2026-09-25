'use client'

import {
  startTransition,
  useCallback,
  useEffect,
  useState,
  useRef,
  type Key
} from 'react'
import dynamic from 'next/dynamic'
import { usePathname, useSearchParams } from 'next/navigation'
import { Tab, Tabs } from '@heroui/tabs'
import { IntroductionTab } from '~/components/patch/introduction/IntroductionTab'
import { KunLoading } from '~/components/kun/Loading'
import { mergePatchTabTargets, readPatchTabTargets } from './tabTargets'
import type { PatchIntroduction } from '~/types/api/patch'

type PatchTabKey = 'introduction' | 'resources' | 'comments' | 'rating'

interface PatchHeaderProps {
  id: number
  vndbId: string
  uid?: number
  intro: PatchIntroduction
}

interface SearchParamsLike {
  get: (key: string) => string | null
  toString: () => string
}

// 预热与 dynamic 必须共用同一个 import(), 否则 Turbopack 会编出两份入口变体块
const loadResourceTab = () => import('~/components/patch/resource/ResourceTab')

const ResourceTab = dynamic(
  () => loadResourceTab().then((mod) => mod.ResourceTab),
  {
    ssr: false,
    loading: () => (
      <KunLoading className="min-h-64" hint="正在加载资源链接..." />
    )
  }
)

const CommentTab = dynamic(
  () =>
    import('~/components/patch/comment/CommentTab').then(
      (mod) => mod.CommentTab
    ),
  {
    ssr: false,
    loading: () => <KunLoading className="min-h-64" hint="正在加载讨论版..." />
  }
)

const RatingTab = dynamic(
  () =>
    import('~/components/patch/rating/RatingTab').then((mod) => mod.RatingTab),
  {
    ssr: false,
    loading: () => (
      <KunLoading className="min-h-64" hint="正在加载游戏评价..." />
    )
  }
)

const isPatchTabKey = (value: string | null): value is PatchTabKey => {
  return (
    value === 'introduction' ||
    value === 'resources' ||
    value === 'comments' ||
    value === 'rating'
  )
}

const getSelectedTab = (searchParams: SearchParamsLike): PatchTabKey => {
  const targetTab = searchParams.get('tab')

  if (targetTab === 'comments' || searchParams.get('commentId')) {
    return 'comments'
  }

  if (targetTab === 'rating' || searchParams.get('ratingId')) {
    return 'rating'
  }

  if (targetTab === 'resources' || searchParams.get('resourceId')) {
    return 'resources'
  }

  return isPatchTabKey(targetTab) ? targetTab : 'introduction'
}

const hasTabDeepLink = (searchParams: SearchParamsLike) => {
  return Boolean(
    searchParams.get('tab') ||
    searchParams.get('commentId') ||
    searchParams.get('ratingId') ||
    searchParams.get('resourceId')
  )
}

export const PatchHeaderTabs = ({
  id,
  vndbId,
  uid,
  intro
}: PatchHeaderProps) => {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const tabsRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<PatchTabKey>(() =>
    getSelectedTab(searchParams)
  )
  const [mountedTabs, setMountedTabs] = useState<Set<PatchTabKey>>(
    () => new Set([selected])
  )
  const [targets, setTargets] = useState(() =>
    readPatchTabTargets(searchParams)
  )
  // 首次渲染就落在资源 tab 时, 面板还只是 256px 的懒加载占位: 此时滚动会因页面
  // 不够长停在半路, 之后「占位 → spinner → 列表」又会推动已滚进视口的页脚.
  // 改为列表渲染完成后再滚; 带 resourceId 时 ResourceTabs 随后会改滚到对应卡片
  const pendingResourceScrollRef = useRef(selected === 'resources')

  // 保持引用稳定, 否则每次 URL 变化都会击穿资源 tab 的 memo
  const handleResourcesLoaded = useCallback(() => {
    if (!pendingResourceScrollRef.current) {
      return
    }
    pendingResourceScrollRef.current = false
    tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // 资源 tab 组约 11KB gz, 水合后预热, 点「资源链接」或「下载」时不必再等块
  useEffect(() => {
    void loadResourceTab()
  }, [])

  useEffect(() => {
    const nextTab = getSelectedTab(searchParams)
    startTransition(() => {
      setSelected(nextTab)
      setMountedTabs((current) => {
        if (current.has(nextTab)) {
          return current
        }
        const next = new Set(current)
        next.add(nextTab)
        return next
      })
      setTargets((current) => mergePatchTabTargets(current, searchParams))
    })

    if (
      hasTabDeepLink(searchParams) &&
      !(nextTab === 'resources' && pendingResourceScrollRef.current)
    ) {
      requestAnimationFrame(() => {
        tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
  }, [searchParams])

  const handleSelectionChange = (value: Key) => {
    const nextTab = value.toString()
    if (!isPatchTabKey(nextTab)) {
      return
    }

    // 在 transition 里挂载懒加载 tab: 块已预热时 React 会等 import() 在微任务里
    // 完成而不先提交 fallback, 从而绕开 Suspense 揭示的 300ms 节流
    startTransition(() => {
      setSelected(nextTab)
      setMountedTabs((current) => {
        if (current.has(nextTab)) {
          return current
        }
        const next = new Set(current)
        next.add(nextTab)
        return next
      })
    })

    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', nextTab)
    if (nextTab !== 'comments') {
      params.delete('commentId')
    }
    if (nextTab !== 'rating') {
      params.delete('ratingId')
    }
    if (nextTab !== 'resources') {
      params.delete('resourceId')
      params.delete('resourceSection')
    }

    const query = params.toString()
    // 只改 ?tab=, 用 history API 同步 useSearchParams; router.replace 会多一次
    // page 段 RSC 往返并让浏览量 +1
    window.history.replaceState(
      null,
      '',
      query ? `${pathname}?${query}` : pathname
    )
  }

  // 访问过的资源 / 讨论 / 评价 tab 切走后保活 (隐藏而不卸载): 切回不重拉, 页码、
  // 草稿与滚动进度都在. 简介例外, 切走即卸载: 保活会让已播放的 PV 视频在隐藏后继续播放.
  // 各 tab 组件均为 memo 且不订阅 URL, 深链目标只经 props 传入, 否则每次点 tab 都会
  // 在点击事件里同步重渲染全部保活面板
  return (
    <div ref={tabsRef} id="patch-detail-tabs">
      <Tabs
        className="w-full my-6 overflow-hidden shadow-medium rounded-large"
        fullWidth={true}
        defaultSelectedKey="introduction"
        onSelectionChange={handleSelectionChange}
        selectedKey={selected}
        destroyInactiveTabPanel={false}
      >
        <Tab key="introduction" title="游戏信息" className="p-0 min-w-20">
          {selected === 'introduction' && (
            <IntroductionTab intro={intro} patchId={Number(id)} uid={uid} />
          )}
        </Tab>

        <Tab key="resources" title="资源链接" className="p-0 min-w-20">
          {mountedTabs.has('resources') && (
            <ResourceTab
              id={id}
              vndbId={vndbId}
              onLoaded={handleResourcesLoaded}
              targetResourceId={targets.resourceId}
              targetResourceSection={targets.resourceSection}
            />
          )}
        </Tab>

        <Tab key="comments" title="讨论版" className="p-0 min-w-20">
          {mountedTabs.has('comments') && (
            <CommentTab id={id} targetCommentId={targets.commentId} />
          )}
        </Tab>

        <Tab key="rating" title="游戏评价" className="p-0 min-w-20">
          {mountedTabs.has('rating') && (
            <RatingTab id={id} targetRatingId={targets.ratingId} />
          )}
        </Tab>
      </Tabs>
    </div>
  )
}
