import { prisma } from '~/prisma/index'
import { kunMoyuMoe } from '~/config/moyu-moe'
import {
  createTotpKey,
  issueBackupCodes,
  SECOND_FACTOR_FAILURE_MESSAGE,
  verifyEnrollmentCode
} from './secondFactor'
import { consumeStepUpBackupCode } from './stepUp'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { StepUpPassed } from './stepUp'

// 2FA 的三次状态迁移 (生成待确认的密钥 → 确认启用 → 关闭)。应用对 enable_2fa、
// two_factor_secret 的写入只在这里, two_factor_backup 除了逐个消费 (twoFactorBackupCode.ts)
// 也只在这里; 一律是带前置状态的条件更新: 平铺 WHERE 的 updateMany 在并发下由数据库重新
// 判定, 命中 0 行就是状态已经被别的请求改了。
// two_factor_secret 的值只在本文件与 secondFactor.ts 里被解读

export const TWO_FACTOR_STATE_CHANGED = '当前 2FA 状态已变化，请刷新后重试'

// 生成一把待确认的密钥。重复调用会换掉上一把还没确认的
export const beginEnrollment = async (
  passed: StepUpPassed<'twoFactor.enroll'>
) => {
  const user = await prisma.user.findUnique({
    where: { id: passed.uid },
    select: { name: true, enable_2fa: true }
  })
  if (!user) {
    return '用户不存在'
  }
  if (user.enable_2fa) {
    return '请先关闭现有 2FA 后再重新设置'
  }

  const key = createTotpKey(
    kunMoyuMoe.titleShort,
    user.name || passed.uid.toString()
  )
  const updated = await prisma.user.updateMany({
    where: { id: passed.uid, enable_2fa: false },
    data: {
      two_factor_secret: key.secret,
      two_factor_backup: [],
      enable_2fa: false
    }
  })
  if (!updated.count) {
    return TWO_FACTOR_STATE_CHANGED
  }

  return { secret: key.secret, authUrl: key.url }
}

// 用户的身份验证器算出了这把密钥的验证码, 才启用并发放备份码。条件里带着刚校验过的那把
// 密钥: 校验与写入之间密钥被换掉、或账号已被另一个请求启用, 都命中 0 行。已启用的账号
// 再来确认会被直接拒绝, 不会悄悄换发一套备份码
export const confirmEnrollment = async (
  uid: number,
  code: string,
  ctx: { ip: string }
) => {
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { enable_2fa: true, two_factor_secret: true }
  })
  if (!user || !user.two_factor_secret) {
    return '未找到 2FA 密钥, 请先生成 2FA 密钥'
  }
  if (user.enable_2fa) {
    return TWO_FACTOR_STATE_CHANGED
  }

  const verified = await verifyEnrollmentCode(
    uid,
    user.two_factor_secret,
    code,
    ctx
  )
  if (!verified.ok) {
    return verified.reason === 'invalid'
      ? '2FA 验证码无效'
      : SECOND_FACTOR_FAILURE_MESSAGE[verified.reason]
  }

  const codes = issueBackupCodes()
  const updated = await prisma.user.updateMany({
    where: {
      id: uid,
      enable_2fa: false,
      two_factor_secret: user.two_factor_secret
    },
    data: { enable_2fa: true, two_factor_backup: codes.stored }
  })
  if (!updated.count) {
    return TWO_FACTOR_STATE_CHANGED
  }

  return { backupCode: codes.plain }
}

// 关闭只有两种授权: 本人刚通过二次验证, 或管理员代为关闭 (由后台路由鉴权并写审计日志)。
// 必须在事务里调: 本人用备份码证明时, 备份码的消费与关闭要么都做、要么都不做。
//   backup-code-gone: 备份码在校验之后被别的请求先用掉了
//   not-enabled: 该账号此刻并未启用
export const disableTwoFactor = async (
  by:
    | StepUpPassed<'twoFactor.disable'>
    | { kind: 'admin-override'; adminUid: number; uid: number },
  tx: Prisma.TransactionClient
): Promise<'disabled' | 'backup-code-gone' | 'not-enabled'> => {
  if (!('kind' in by) && !(await consumeStepUpBackupCode(by, tx))) {
    return 'backup-code-gone'
  }

  const updated = await tx.user.updateMany({
    where: { id: by.uid, enable_2fa: true },
    data: { enable_2fa: false, two_factor_secret: '', two_factor_backup: [] }
  })
  return updated.count === 1 ? 'disabled' : 'not-enabled'
}
