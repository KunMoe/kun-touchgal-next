'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Tooltip } from '@heroui/tooltip'
import { KunUserCardSkeleton } from './KunUserCardSkeleton'
import type { ReactElement } from 'react'

const KunUserCard = dynamic(() => import('./KunUserCard'), {
  ssr: false,
  loading: () => <KunUserCardSkeleton />
})

export const preloadKunUserCard = () => {
  void import('./KunUserCard')
}

interface Props {
  uid: number
  children: ReactElement
}

export const KunUserCardTooltip = ({ uid, children }: Props) => {
  const [isCardRequested, setIsCardRequested] = useState(false)

  return (
    <Tooltip
      showArrow
      delay={500}
      closeDelay={200}
      content={isCardRequested ? <KunUserCard uid={uid} /> : null}
      onOpenChange={(isOpen) => {
        if (isOpen) {
          setIsCardRequested(true)
        }
      }}
      classNames={{
        content: ['bg-background/70 backdrop-blur-md']
      }}
    >
      {children}
    </Tooltip>
  )
}
