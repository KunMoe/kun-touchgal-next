import { Toaster } from 'react-hot-toast'
import { Suspense } from 'react'
import { Providers } from './providers'
import { KunTopBar } from '~/components/kun/top-bar/TopBar'
import { KunTopBarSession } from '~/components/kun/top-bar/TopBarSession'
import { KunFooter } from '~/components/kun/Footer'
import { KunNavigationBreadcrumb } from '~/components/kun/NavigationBreadcrumb'
import { generateKunMetadata, kunViewport } from './metadata'
import { KunBackToTop } from '~/components/kun/BackToTop'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { preconnect, prefetchDNS } from 'react-dom'
import { getServerUserSession } from '~/app/api/user/session/service'
import type { Metadata, Viewport } from 'next'
import '~/styles/index.css'

export const viewport: Viewport = kunViewport
export const metadata: Metadata = generateKunMetadata()

export default function RootLayout({
  children
}: {
  children: React.ReactNode
}) {
  preconnect(kunMoyuMoe.domain.imageBed)
  prefetchDNS(kunMoyuMoe.domain.imageBed)
  const initialSession = getServerUserSession()
  return (
    // next-themes 会在客户端接管 <html> 的 class；只在根节点允许该不可避免差异。
    <html lang="zh-Hans" suppressHydrationWarning>
      {process.env.KUN_VISUAL_NOVEL_TEST_SITE_LABEL && (
        <head>
          <meta name="robots" content="noindex,nofollow" />
          <meta name="googlebot" content="noindex,nofollow" />
        </head>
      )}

      <body>
        <Providers>
          <div className="relative flex flex-col items-center justify-center min-h-dvh bg-radial">
            <Suspense
              fallback={
                <KunTopBar initialSession={null} isSessionPending={true} />
              }
            >
              <KunTopBarSession initialSession={initialSession} />
            </Suspense>
            <KunNavigationBreadcrumb />
            {/* 流式外置的 Suspense 边界由内联 $RC 延迟揭示; 揭示前隐藏页脚, 长内容揭示时就不会把可见的页脚推下去 */}
            <div className="flex min-h-[calc(100dvh-256px)] w-full max-w-7xl grow px-3 sm:px-6 [&:has(template[id^=B])~footer]:invisible">
              {children}
              <Toaster />
            </div>
            <KunBackToTop />
            <KunFooter />
          </div>
        </Providers>
      </body>
    </html>
  )
}
