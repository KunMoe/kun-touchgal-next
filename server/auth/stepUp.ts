import { prisma } from '~/prisma/index'
import { verifyPassword } from './algorithm'
import { reserveAttempt, settleSuccess } from './attemptBudget'
import { stepUpPasswordDims } from './budgets'
import {
  SECOND_FACTOR_FAILURE_MESSAGE,
  verifySecondFactor
} from './secondFactor'
import { consumeTwoFactorBackupCode } from './twoFactorBackupCode'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { SecondFactorProof } from './secondFactor'

// 已登录用户改动账户安全属性之前「再证明一次你是你」。哪种操作要哪些因子只写在这张表里,
// 新增一个敏感操作就是加一行; 路由不再各自决定验什么、按什么顺序验。
//
// 'sessions.revokeOthers' (吊销其它会话) 刻意不进表: 它是保护性动作, 也是 step-up 预算被
// 会话窃取者耗尽时受害者的逃生口, 不要求二次验证。

export type SensitiveAction =
  'password.change' | 'email.change' | 'twoFactor.enroll' | 'twoFactor.disable'

interface StepUpRequirement {
  password: 'required' | 'never'
  // if-enabled: 账号启用了 2FA 才要
  secondFactor: 'required' | 'if-enabled' | 'never'
}

export const STEP_UP_POLICY = {
  'password.change': { password: 'required', secondFactor: 'never' },
  // 只验第二因子的话, 开启 2FA 反而把门槛从密码降成一个 6 位数
  'email.change': { password: 'required', secondFactor: 'if-enabled' },
  // 只凭会话就能生成密钥的话, 被窃的会话可以给账号挂上别人的身份验证器
  'twoFactor.enroll': { password: 'required', secondFactor: 'never' },
  'twoFactor.disable': { password: 'never', secondFactor: 'required' }
} as const satisfies Record<SensitiveAction, StepUpRequirement>

// 品牌不导出: 只有 requireStepUp 造得出 StepUpPassed, 状态迁移函数 (twoFactorState、
// emailChange) 只收它, 「忘了二次验证就改库」过不了类型检查。防的是写错, 不是安全边界
declare const stepUpBrand: unique symbol

export type StepUpPassed<A extends SensitiveAction> = {
  readonly uid: number
  readonly action: A
  // 第二因子是备份码时, 它已校验但还没消费: 收这个值的状态迁移函数要在自己的事务里
  // 调 consumeStepUpBackupCode
  readonly backupCode?: string
  readonly [stepUpBrand]: true
}

// 形状来自 validations/user.ts 的 stepUpProofSchema
export interface StepUpProof {
  currentPassword?: string
  totp?: string
  backupCode?: string
}

export type StepUpFailureReason =
  'missing' | 'invalid' | 'replayed' | 'locked' | 'unavailable'

export type StepUpResult<A extends SensitiveAction> =
  | { ok: true; passed: StepUpPassed<A> }
  | { ok: false; reason: StepUpFailureReason; message: string }

export interface StepUpContext {
  ip: string
}

const fail = (reason: StepUpFailureReason, message: string) =>
  ({ ok: false, reason, message }) as const

const UNAVAILABLE = fail(
  'unavailable',
  SECOND_FACTOR_FAILURE_MESSAGE.unavailable
)

const secondFactorProofOf = (proof: StepUpProof): SecondFactorProof | null => {
  if (proof.backupCode) {
    return { kind: 'backup', code: proof.backupCode }
  }
  return proof.totp ? { kind: 'totp', code: proof.totp } : null
}

// 顺序固定: 预算 → 读凭据 → 校验。先过密码, 再过第二因子: 密码不对时不消耗第二因子的额度,
// 也不透露第二因子对不对。调用方必须把它排在任何「目标是否可用」的查询之前。
// 这里没有任何库写入, 不要放进事务里调 (中间有 Redis 往返)
export const requireStepUp = async <A extends SensitiveAction>(
  uid: number,
  action: A,
  proof: StepUpProof,
  ctx: StepUpContext
): Promise<StepUpResult<A>> => {
  const policy: StepUpRequirement = STEP_UP_POLICY[action]
  const passwordDims =
    policy.password === 'required' ? stepUpPasswordDims(uid, ctx.ip) : null

  if (passwordDims) {
    if (!proof.currentPassword) {
      return fail('missing', '请输入当前密码')
    }

    let reservation
    try {
      reservation = await reserveAttempt(passwordDims)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[stepUp] reserve', error)
      return UNAVAILABLE
    }
    if (!reservation.allowed) {
      return fail('locked', '密码尝试次数过多, 请 15 分钟后再试')
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { password: true, enable_2fa: true }
  })
  if (!user) {
    return fail('invalid', '用户不存在')
  }

  if (passwordDims) {
    if (!(await verifyPassword(proof.currentPassword ?? '', user.password))) {
      return fail('invalid', '当前密码输入错误')
    }
    // 清不掉计数只是此前的失败没被勾销, 不能因此判失败
    await settleSuccess(passwordDims).catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[stepUp] settle', error)
    })
  }

  let backupCode: string | undefined
  if (
    policy.secondFactor === 'required' ||
    (policy.secondFactor === 'if-enabled' && user.enable_2fa)
  ) {
    if (!user.enable_2fa) {
      return fail('invalid', '用户未启用 2FA')
    }
    const secondFactor = secondFactorProofOf(proof)
    if (!secondFactor) {
      return fail('missing', '请输入 2FA 验证码')
    }

    const verified = await verifySecondFactor(uid, secondFactor, ctx)
    if (!verified.ok) {
      return fail(
        verified.reason,
        verified.reason === 'invalid'
          ? '2FA 验证码无效'
          : SECOND_FACTOR_FAILURE_MESSAGE[verified.reason]
      )
    }
    if (secondFactor.kind === 'backup') {
      backupCode = secondFactor.code
    }
  }

  return {
    ok: true,
    passed: {
      uid,
      action,
      ...(backupCode && { backupCode })
    } as StepUpPassed<A>
  }
}

export const STEP_UP_BACKUP_CODE_GONE = '2FA 验证码无效'

// 与它所授权的变更同一个事务: 变更回滚, 备份码也回来。返回 false 表示这个码在校验之后
// 被别的请求先用掉了, 调用方应让事务失败 (文案用 STEP_UP_BACKUP_CODE_GONE)
export const consumeStepUpBackupCode = async (
  passed: StepUpPassed<SensitiveAction>,
  tx: Prisma.TransactionClient
) =>
  !passed.backupCode ||
  consumeTwoFactorBackupCode(passed.uid, passed.backupCode, tx)
