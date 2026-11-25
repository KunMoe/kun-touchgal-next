import { prisma } from '~/prisma/index'
import type { KunTx } from '~/prisma/index'
import { kunMoyuMoe } from '~/config/moyu-moe'
import {
  createTotpKey,
  isSealedTotpSecret,
  issueBackupCodes,
  sealTotpSecret,
  SECOND_FACTOR_FAILURE_MESSAGE,
  verifyEnrollmentCode
} from './secondFactor'
import { consumeStepUpBackupCode } from './stepUp'
import { applyKunCredentialChange } from './securityEvents'
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
  const updated = await applyKunCredentialChange(prisma, {
    uid: passed.uid,
    event: '2fa-secret-staged',
    where: { enable_2fa: false },
    data: {
      two_factor_secret: key.stored,
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
// ctx.currentStamp: 发起启用的会话令牌带的安全戳 (tokenStampOf), 见 applyKunCredentialChange
export const confirmEnrollment = async (
  uid: number,
  code: string,
  ctx: { ip: string; currentStamp: number }
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
    { ip: ctx.ip }
  )
  if (!verified.ok) {
    return verified.reason === 'invalid'
      ? '2FA 验证码无效'
      : SECOND_FACTOR_FAILURE_MESSAGE[verified.reason]
  }

  const codes = issueBackupCodes()
  const updated = await applyKunCredentialChange(prisma, {
    uid,
    event: '2fa-enabled',
    where: { enable_2fa: false, two_factor_secret: user.two_factor_secret },
    data: { enable_2fa: true, two_factor_backup: codes.stored },
    currentStamp: ctx.currentStamp
  })
  if (!updated.count) {
    return TWO_FACTOR_STATE_CHANGED
  }

  // stamp 交给 finishKunSecurityEvent, 不回给客户端
  return { backupCode: codes.plain, stamp: updated.stamp }
}

// 关闭只有两种授权: 本人刚通过二次验证, 或管理员代为关闭 (由后台路由鉴权并写审计日志)。
// 必须在事务里调: 本人用备份码证明时, 备份码的消费与关闭要么都做、要么都不做。
//   backup-code-gone: 备份码在校验之后被别的请求先用掉了
//   not-enabled: 该账号此刻并未启用
// 关闭成功时带上这次写下的安全戳, 提交之后交给 finishKunSecurityEvent。
// 本人关闭要传当前会话令牌带的戳 (currentStamp, 见 applyKunCredentialChange); 管理员代关不传
export const disableTwoFactor = async (
  by:
    | StepUpPassed<'twoFactor.disable'>
    | { kind: 'admin-override'; adminUid: number; uid: number },
  tx: KunTx,
  currentStamp?: number
): Promise<
  | { outcome: 'disabled'; stamp: Date | null }
  | { outcome: 'backup-code-gone' | 'not-enabled' }
> => {
  const isAdmin = 'kind' in by
  if (!isAdmin && !(await consumeStepUpBackupCode(by, tx))) {
    return { outcome: 'backup-code-gone' }
  }

  const updated = await applyKunCredentialChange(tx, {
    uid: by.uid,
    event: isAdmin ? '2fa-disabled-by-admin' : '2fa-disabled',
    where: { enable_2fa: true },
    data: { enable_2fa: false, two_factor_secret: '', two_factor_backup: [] },
    currentStamp: isAdmin ? undefined : currentStamp
  })
  return updated.count === 1
    ? { outcome: 'disabled', stamp: updated.stamp }
    : { outcome: 'not-enabled' }
}

// 把存量的明文 TOTP 种子改存密文 (scripts/encryptTotpSecrets.ts 调用)。按 id 分批扫描有种子的行,
// 以读到的明文为条件逐行写入: 扫描之后被重新绑定或关闭了 2FA 的行命中 0 行, 不会被覆盖。
// apply 为 false 时只数不写。已是密文的行跳过, 重复执行无害
export const sealLegacyTotpSecrets = async ({
  apply,
  batchSize = 500
}: {
  apply: boolean
  batchSize?: number
}) => {
  let pending = 0
  let sealed = 0
  let changed = 0
  let cursorId = 0

  while (true) {
    const batch = await prisma.user.findMany({
      where: { id: { gt: cursorId }, two_factor_secret: { not: '' } },
      select: { id: true, two_factor_secret: true },
      orderBy: { id: 'asc' },
      take: batchSize
    })
    if (batch.length === 0) {
      break
    }
    cursorId = batch[batch.length - 1].id

    for (const row of batch) {
      if (isSealedTotpSecret(row.two_factor_secret)) {
        continue
      }
      pending++
      if (!apply) {
        continue
      }
      const updated = await applyKunCredentialChange(prisma, {
        uid: row.id,
        event: '2fa-secret-sealed',
        where: { two_factor_secret: row.two_factor_secret },
        data: { two_factor_secret: sealTotpSecret(row.two_factor_secret) }
      })
      if (updated.count) {
        sealed++
      } else {
        changed++
      }
    }
  }

  return { pending, sealed, changed }
}
