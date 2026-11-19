'use client'

import { useEffect } from 'react'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { getPatchPageTitle } from '~/utils/patch/getPatchPageTitle'
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

    document.title = `${getPatchPageTitle(patch)} - ${kunMoyuMoe.titleShort}`
  }, [isNsfwBlocked, patch])

  return null
}
