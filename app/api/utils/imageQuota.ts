import { prisma } from '~/prisma/index'
import { ImageRejection } from '~/server/image/pipeline'

// 每日单用户图片上传额度上限. 抽为常量, 使原子抢占与各入口错误文案共用同一阈值,
// 避免像 H-03 那样在多个上传入口各自硬编码 "50" 而漂移
export const DAILY_IMAGE_LIMIT = 50

export const DAILY_IMAGE_QUOTA_EXHAUSTED = `您今日上传的图片已达到 ${DAILY_IMAGE_LIMIT} 张限额`

// 原子抢占一个每日图片额度: 单条 updateMany 在数据库层同时完成
// "daily_image_count < 上限" 判定与 +1, 二者不可被并发请求穿插.
// 取代 "先 findUnique 读计数判断、再 update 递增" 的两步写法 —— 后者存在 TOCTOU:
// 同一用户并发多请求会同时读到低于上限而集体放行, 突破每日额度并让编码 / 上传资源被过量占用.
// 返回 true = 抢占成功 (计数已 +1); false = 已达上限, 调用方必须拒绝且不得继续消耗编码资源
export const claimDailyImageQuota = async (uid: number): Promise<boolean> => {
  const claimed = await prisma.user.updateMany({
    where: { id: uid, daily_image_count: { lt: DAILY_IMAGE_LIMIT } },
    data: { daily_image_count: { increment: 1 } }
  })
  return claimed.count > 0
}

// 抢占成功但后续编码 / 上传失败时的补偿: 退还先前占用的 1 个额度, 使 "尝试并失败"
// 不永久扣费. 与 claimDailyImageQuota 的 +1 对称. 用 updateMany 而非 update, 且 where
// 带 gte: 1 下限守卫 —— 抢占与退还之间隔着编码与 S3 上传, 期间用户可能被删, 计数也可能
// 被 resetDailyTask 清零或被 admin 下调; 三者都只让退还 0 行受影响, 既不抛错也不会把
// 计数减成负数. 形状对齐姊妹退还 patch/resource/_helper.ts
export const refundDailyImageQuota = async (uid: number): Promise<void> => {
  await prisma.user.updateMany({
    where: { id: uid, daily_image_count: { gte: 1 } },
    data: { daily_image_count: { decrement: 1 } }
  })
}

// 图床与头像共用的额度包装: 抢占 → work → 按结果落定或退还。work 在调用方准入之后、只做编码与写入:
// - 抢不到: 返回限额文案, 不调 work
// - 返回 ImageRejection: 不计费的 (排队忙) 退还, 计费的 (解码失败、编码后超限) 不退, 都返回文案
// - 抛错: 这时只剩 S3 等基础设施错误, 退还后原样抛出; 退还自己失败不盖住原始错误
// 形状照抄 patch/resource/_helper.ts 的退还路径
export const withDailyImageQuota = async <T>(
  uid: number,
  work: () => Promise<T | ImageRejection>
): Promise<T | string> => {
  if (!(await claimDailyImageQuota(uid))) {
    return DAILY_IMAGE_QUOTA_EXHAUSTED
  }

  let res: T | ImageRejection
  try {
    res = await work()
  } catch (error) {
    await refundDailyImageQuota(uid).catch(() => undefined)
    throw error
  }
  if (res instanceof ImageRejection) {
    if (!res.billable) {
      await refundDailyImageQuota(uid).catch(() => undefined)
    }
    return res.message
  }
  return res
}
