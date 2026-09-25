'use client'

import { ProgressProvider } from '@bprogress/next/app'
import { HeroUIProvider } from '@heroui/system'
import { ThemeProvider } from 'next-themes'
import { useRouter } from 'next/navigation'

export const Providers = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter()
  return (
    <ProgressProvider
      shallowRouting
      color="#006FEE"
      height="4px"
      options={{ showSpinner: false }}
    >
      <HeroUIProvider navigate={router.push}>
        <ThemeProvider attribute="class">{children}</ThemeProvider>
      </HeroUIProvider>
    </ProgressProvider>
  )
}
