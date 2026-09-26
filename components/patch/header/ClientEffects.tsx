'use client'

import { useEffect } from 'react'
import { useRewritePatchStore } from '~/store/rewriteStore'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { getPatchPageTitle } from '~/utils/patch/getPatchPageTitle'
import type { Patch } from '~/types/api/patch'

interface Props {
  patch: Patch
  // 仅 role≥3 下发; patch 上的同名字段恒为空值
  rewrite: Pick<Patch, 'introduction' | 'tags'> | null
  released: string
  isNsfwBlocked: boolean
}

export const PatchHeaderClientEffects = ({
  patch,
  rewrite,
  released,
  isNsfwBlocked
}: Props) => {
  const setData = useRewritePatchStore((state) => state.setData)
  const resetData = useRewritePatchStore((state) => state.resetData)

  useEffect(() => {
    // 必须清空而不是用空值预填: PUT /edit 的 tag 是全量同步, 空数组会删光该
    // patch 的标签; 清空后 id 为 0, 提交会被 patchUpdateSchema 拦下
    if (!rewrite) {
      resetData()
      return
    }

    setData({
      id: patch.id,
      uniqueId: patch.uniqueId,
      vndbId: patch.vndbId ?? '',
      vndbRelationId: patch.vndbRelationId ?? '',
      bangumiId: patch.bangumiId ? String(patch.bangumiId) : '',
      steamId: patch.steamId ? String(patch.steamId) : '',
      dlsiteCode: patch.dlsiteCode ?? '',
      dlsiteCircleName: '',
      dlsiteCircleLink: '',
      vndbTags: [],
      vndbDevelopers: [],
      bangumiTags: [],
      bangumiDevelopers: [],
      steamTags: [],
      steamDevelopers: [],
      steamAliases: [],
      name: patch.name,
      introduction: rewrite.introduction,
      alias: patch.alias,
      tag: rewrite.tags,
      contentLimit: patch.contentLimit,
      released
    })
  }, [patch, rewrite, released, setData, resetData])

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
