import { kunRoute } from '~/app/api/utils/kunRoute'
import { KUN_BODY_BUDGET } from '~/constants/bodyBudget'
import { prisma } from '~/prisma/index'
import { uploadIntroductionImage } from './_upload'
import { newContentImageKey } from '~/server/storage/imageObjects'
import { imageSchema } from '~/validations/edit'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { withDailyImageQuota } from '~/app/api/utils/imageQuota'
import { ImageRejection, admitImage } from '~/server/image/pipeline'

const uploadImage = async (uid: number, image: ArrayBuffer) => {
  const user = await prisma.user.findUnique({
    where: { id: uid }
  })
  if (!user) {
    return '用户未找到'
  }
  // 准入在抢额度之前: 认不出、不收的格式与像素炸弹不扣额度, 也不进编码队列
  const admitted = await admitImage(image)
  if (admitted instanceof ImageRejection) {
    return admitted.message
  }

  const { key, url } = newContentImageKey(uid)

  const res = await withDailyImageQuota(uid, () =>
    uploadIntroductionImage(key, admitted)
  )
  if (typeof res === 'string') {
    return res
  }

  await invalidateUserSession(uid)

  return { imageLink: url }
}

export const POST = kunRoute.post({
  auth: 'user',
  form: true,
  maxBytes: KUN_BODY_BUDGET.image,
  input: imageSchema,
  handler: async ({ input, actor: payload }) => {
    const image = await new Response(input.image)?.arrayBuffer()

    return uploadImage(payload.uid, image)
  }
})
