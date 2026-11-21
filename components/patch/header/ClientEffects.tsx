'use client'

import { useEffect } from 'react'
import { getPatchPageTitle } from '~/utils/patch/getPatchPageTitle'
import { kunDocumentTitle } from '~/utils/pageMetadata'
import type { Patch } from '~/types/api/patch'

interface Props {
  patch: Patch
  isNsfwBlocked: boolean
}

export const PatchHeaderClientEffects = ({ patch, isNsfwBlocked }: Props) => {
  useEffect(() => {
    if (patch.contentLimit !== 'nsfw') {
      return
    }

    if (isNsfwBlocked) {
      document.title = ''
      return
    }

    document.title = kunDocumentTitle(getPatchPageTitle(patch))
  }, [isNsfwBlocked, patch])

  return null
}
