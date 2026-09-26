'use client'

import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import {
  createBreadcrumbItem,
  getBreadcrumbTitleKey
} from '~/constants/routes/routes'
import { isPatchResourcePath } from '~/constants/routes/matcher'
import { initialBreadcrumbItems, useBreadcrumbStore } from '~/store/breadcrumb'
import { cn } from '~/utils/cn'

export const KunNavigationBreadcrumb = () => {
  const pathname = usePathname()
  const params = useParams()
  const titleKey = getBreadcrumbTitleKey(pathname, params)
  const pageTitle = useBreadcrumbStore((state) => state.titles[titleKey])
  // 资源详情页的中间层级 (游戏名) 由页面以 `/${id}` 为键单独注册
  const patchTitle = useBreadcrumbStore((state) =>
    isPatchResourcePath(pathname) ? state.titles[`/${params.id}`] : undefined
  )
  const items = [
    ...initialBreadcrumbItems,
    ...createBreadcrumbItem(pathname, params, pageTitle, patchTitle)
  ]

  const hideBreadcrumbRoutes = [
    '/',
    '/edit/create',
    '/edit/rewrite',
    '/redirect',
    '/friend-link',
    '/apply',
    '/apply/pending',
    '/apply/success',
    '/register'
  ]

  if (
    hideBreadcrumbRoutes.includes(pathname) ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/login' ||
    pathname.startsWith('/login/') ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/oidc/')
  ) {
    return null
  }

  return (
    // mb-2 与内容容器自身的 mt-4 叠加为 24px, 与卡片间距 (space-y-6) 一致
    <div className="w-full mt-4 mb-2 bg-background/60 backdrop-blur-lg">
      <nav aria-label="Breadcrumb" className="px-3 mx-auto sm:px-6 max-w-7xl">
        <ol className="flex flex-nowrap items-center gap-1 overflow-hidden text-sm text-foreground/60">
          {items.map((item, index) => {
            // 标题未注册 (SSR / NSFW 屏蔽) 时游戏页塌缩到 Galgame, 末项不是当前页, 须保持链接
            const isCurrent =
              index === items.length - 1 && item.key === titleKey

            return (
              <li
                key={item.key}
                // 当前项弹性收缩吃剩余宽度; 其余项定宽不收缩, 保证只截断一处
                className={cn(
                  'flex items-center gap-1',
                  isCurrent ? 'min-w-0' : 'shrink-0'
                )}
              >
                {index > 0 && (
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-foreground/40"
                  />
                )}

                {isCurrent ? (
                  <span
                    aria-current="page"
                    title={item.label}
                    className="min-w-0 truncate text-foreground"
                  >
                    {item.label}
                  </span>
                ) : (
                  <Link
                    title={item.label}
                    className="max-w-32 truncate transition-colors hover:text-foreground sm:max-w-96"
                    href={item.href}
                  >
                    {item.label}
                  </Link>
                )}
              </li>
            )
          })}
        </ol>
      </nav>
    </div>
  )
}
