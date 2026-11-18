import { NextRequest, NextResponse } from 'next/server'
import { kunParseFormData } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { updatePatchBannerSchema } from '~/validations/patch'
import { uploadPatchBanner } from '~/app/api/edit/_upload'
import { purgeCloudflareCache } from '~/app/api/utils/purgeCloudflareCache'
import { can } from '~/constants/permission'

const purgeCache = async (patchId: number) => {
  const imageBedUrl = process.env.KUN_VISUAL_NOVEL_IMAGE_BED_URL
  const patchBannerUrl = `${imageBedUrl}/patch/${patchId}/banner/banner.avif`
  const patchBannerMiniUrl = `${imageBedUrl}/patch/${patchId}/banner/banner-mini.avif`
  const patchBannerFullUrl = `${imageBedUrl}/patch/${patchId}/banner/banner-full.avif`

  return purgeCloudflareCache([
    patchBannerUrl,
    patchBannerMiniUrl,
    patchBannerFullUrl
  ])
}

const updatePatchBanner = async (
  image: ArrayBuffer,
  patchId: number,
  originalImage?: ArrayBuffer
) => {
  const patch = await prisma.patch.findUnique({
    where: { id: patchId },
    select: { id: true }
  })
  if (!patch) {
    return '这个 Galgame 不存在'
  }

  const res = await uploadPatchBanner(image, patchId, originalImage)
  if (typeof res === 'string') {
    return res
  }

  // best-effort: banner 已上传成功, purge 失败不应使请求整体报错
  await purgeCache(patchId).catch((error) =>
    console.error('Failed to purge banner CDN cache:', error)
  )

  return {}
}

export const POST = async (req: NextRequest) => {
  const input = await kunParseFormData(req, updatePatchBannerSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'banner.edit')) {
    return NextResponse.json('本页面仅管理员可访问')
  }

  const image = await new Response(input.image)?.arrayBuffer()
  const originalImage = input.imageOriginal
    ? await new Response(input.imageOriginal)?.arrayBuffer()
    : undefined

  const response = await updatePatchBanner(image, input.patchId, originalImage)
  return NextResponse.json(response)
}
