import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { updatePatchBannerSchema } from '~/validations/patch'
import { encodePatchBanner } from '~/app/api/edit/_upload'
import { replacePatchBanner } from '~/server/storage/patchBanner'

const updatePatchBanner = async (
  image: ArrayBuffer,
  patchId: number,
  originalImage: ArrayBuffer | undefined,
  discardOld: boolean
) => {
  // 编码要几秒, 不存在的游戏先挡掉; 是否存在以换指针时行锁下的读为准
  const patch = await prisma.patch.findUnique({
    where: { id: patchId },
    select: { id: true }
  })
  if (!patch) {
    return '这个 Galgame 不存在'
  }

  const encoded = await encodePatchBanner(image, originalImage)
  if (typeof encoded === 'string') {
    return encoded
  }

  return replacePatchBanner(patchId, encoded, { discardOld })
}

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'banner.edit',
  form: true,
  input: updatePatchBannerSchema,
  handler: async ({ input }) => {
    const image = await new Response(input.image)?.arrayBuffer()
    const originalImage = input.imageOriginal
      ? await new Response(input.imageOriginal)?.arrayBuffer()
      : undefined

    return updatePatchBanner(
      image,
      input.patchId,
      originalImage,
      input.discardOld === 'true'
    )
  }
})
