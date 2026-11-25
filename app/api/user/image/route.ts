import { kunRoute } from '~/app/api/utils/kunRoute'
import { KUN_BODY_BUDGET } from '~/constants/bodyBudget'
import { prisma } from '~/prisma/index'
import { uploadIntroductionImage } from './_upload'
import { newContentImageKey } from '~/server/storage/imageObjects'
import { imageSchema } from '~/validations/edit'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import {
  claimDailyImageQuota,
  refundDailyImageQuota
} from '~/app/api/utils/imageQuota'

const uploadImage = async (uid: number, image: ArrayBuffer) => {
  const user = await prisma.user.findUnique({
    where: { id: uid }
  })
  if (!user) {
    return '用户未找到'
  }
  // 编码前原子抢占每日额度: 抢不到直接拒绝, 不进入编码队列 (限制 "已承诺的总工作量").
  // 取代原先 "先读计数判断再递增" 的两步写法, 杜绝并发下的 TOCTOU 越额
  if (!(await claimDailyImageQuota(uid))) {
    return '您今日上传的图片已达到 50 张限额'
  }

  const { key, url } = newContentImageKey(uid)

  // 抢占后编码 / 上传失败则退还额度; 上传成功则额度落定 (S3 资源已消耗)
  let res: string | undefined
  try {
    res = await uploadIntroductionImage(key, image)
  } catch (error) {
    await refundDailyImageQuota(uid)
    throw error
  }
  if (typeof res === 'string') {
    await refundDailyImageQuota(uid)
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
