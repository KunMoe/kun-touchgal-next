import { PatchHeaderTabs } from './Tabs'
import { PatchHeaderInfo } from './Info'
import { PatchHeaderClientEffects } from './ClientEffects'
import { KunAutoImageViewer } from '~/components/kun/image-viewer/AutoImageViewer'
import { KunNull } from '~/components/kun/Null'
import type { Patch, PatchIntroduction } from '~/types/api/patch'

interface PatchHeaderProps {
  patch: Patch
  intro: PatchIntroduction
  uid?: number
  nsfwAllowed: boolean
  canRewrite: boolean
}

export const PatchHeaderContainer = ({
  patch,
  intro,
  uid,
  nsfwAllowed,
  canRewrite
}: PatchHeaderProps) => {
  const isNsfwBlocked = patch.contentLimit === 'nsfw' && !nsfwAllowed
  // 各客户端组件必须共用同一个 patch 引用, Flight 才只序列化一次. markdown 原文与
  // tags 只用于 /edit/rewrite 预填, 仅对能进入该页的 role≥3 经 rewrite 单独下发
  const clientPatch = { ...patch, introduction: '', tags: [] }
  const rewrite = canRewrite
    ? { introduction: patch.introduction, tags: patch.tags }
    : null
  // intro.tag 只有登录用户可见 (IntroductionTab 按 uid 渲染 PatchTag)
  const clientIntro = uid ? intro : { ...intro, tag: [] }

  return (
    <div className="relative w-full mx-auto max-w-7xl">
      {isNsfwBlocked ? (
        <KunNull
          message={
            !uid ? '请登录后查看' : '请在右上角菜单开启 NSFW 内容显示后查看'
          }
        />
      ) : (
        <>
          <PatchHeaderClientEffects
            patch={clientPatch}
            rewrite={rewrite}
            released={intro.released}
            isNsfwBlocked={isNsfwBlocked}
          />
          <KunAutoImageViewer />

          <PatchHeaderInfo patch={clientPatch} />

          <PatchHeaderTabs
            id={patch.id}
            vndbId={patch.vndbId || ''}
            intro={clientIntro}
            uid={uid}
          />
        </>
      )}
    </div>
  )
}
