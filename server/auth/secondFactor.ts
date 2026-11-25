import { generateBackupCodes, generateConfig, Hotp, Totp } from 'time2fa'
import { prisma } from '~/prisma/index'
import { setKvIfAbsent } from '~/lib/redis'
import { createSecretBox } from '~/lib/crypto/secretBox'
import { reserveAttempt, settleSuccess } from './attemptBudget'
import { stepUpSecondFactorDims } from './budgets'
import {
  hashTwoFactorBackupCode,
  matchesTwoFactorBackupCode
} from './twoFactorBackupCode'

// 第二因子 (TOTP 与备份码) 的唯一校验点, 也是全仓唯一允许 import time2fa 的文件
// (kun/inv-auth-01)。time2fa 的 validate 是纯函数, 只回布尔值: 没有地方登记已用的时间步,
// 漂移窗口也只能逐处传参。这里把三件耦合的事放在一起:
//   漂移: 固定接受前后各一个时间步, 跨步长到达的正确验证码不再被拒;
//   重放: 命中的时间步按用户登记, 登录与设置页共用这份登记, 同一个码不能先用来登录、
//         再拿去关 2FA。只放宽漂移不防重放, 可重放的窗口会从约 15 秒变成约 45 秒;
//   预算: 已登录后的二次验证走 budgets.ts 的 step-up 桶 (登录有自己的预约, 不共桶)

// sha1 / 6 位 / 30 秒, 与身份验证器应用的默认值一致
const TOTP_CONFIG = generateConfig()
// 一个码在它所属时间步的前后各一步内都可接受, 最长约 90 秒; 登记要盖过这段时间
const USED_STEP_TTL_SECONDS = 120
// 10 个 6 位备份码在每账号 10 次 / 15 分钟的预算下约 104 天被撞中一个, 10 位是它的一万倍。
// 存量的 6 位码继续可用, 校验层两种长度都收 (validations/secondFactor.ts)
const BACKUP_CODE_COUNT = 10
const BACKUP_CODE_LENGTH = 10

// TOTP 种子加密落库 (库只读泄露时不交出可用的第二因子)。只在生成时 seal (createTotpKey)、
// 校验时 open (checkTotp); 存量明文没有前缀, open 原样返回, 回填前后都能校验。
// 空串表示没有种子, 不加密
const totpSecretBox = createSecretBox('KUN_TWO_FACTOR_SECRET_ENC_KEY')

export const isSealedTotpSecret = totpSecretBox.isSealed
export const sealTotpSecret = totpSecretBox.seal

export const SECOND_FACTOR_FAILURE_MESSAGE = {
  invalid: '验证码无效',
  replayed: '该验证码已经使用过, 请等身份验证器显示新的验证码后再试',
  locked: '验证尝试次数过多, 请 15 分钟后再试',
  unavailable: '验证服务暂不可用, 请稍后重试'
} as const

export type SecondFactorFailure = keyof typeof SECOND_FACTOR_FAILURE_MESSAGE

export type SecondFactorResult =
  { ok: true } | { ok: false; reason: SecondFactorFailure }

export type SecondFactorProof = { kind: 'totp' | 'backup'; code: string }

export interface SecondFactorContext {
  ip: string
}

// 返回命中的时间步 (计数器), 都不中返回 null。先比当前步, 再比前一步与后一步
export const matchTotpStep = (
  secret: string,
  passcode: string,
  nowMs: number
): number | null => {
  const code = passcode.replace(/\s/g, '')
  if (code.length !== TOTP_CONFIG.digits) {
    return null
  }

  const current = Math.floor(nowMs / 1000 / TOTP_CONFIG.period)
  for (const step of [current, current - 1, current + 1]) {
    if (
      Hotp.generatePasscode({ secret, counter: step }, TOTP_CONFIG) === code
    ) {
      return step
    }
  }
  return null
}

// 校验并登记时间步。storedSecret 是库里 two_factor_secret 的原值 (密文或存量明文)。
// Redis 异常与解密失败直接抛出: 登记不了就无法防重放, 解不开就无从校验, 调用方不得放行
export const checkTotp = async (
  uid: number,
  storedSecret: string,
  code: string
): Promise<'ok' | 'invalid' | 'replayed'> => {
  const step = matchTotpStep(totpSecretBox.open(storedSecret), code, Date.now())
  if (step === null) {
    return 'invalid'
  }

  const fresh = await setKvIfAbsent(
    `auth:totp:used:${uid}:${step}`,
    '1',
    USED_STEP_TTL_SECONDS
  )
  return fresh ? 'ok' : 'replayed'
}

const unavailable = (stage: string, error: unknown): SecondFactorResult => {
  // eslint-disable-next-line no-console
  console.error(`[secondFactor] ${stage}`, error)
  return { ok: false, reason: 'unavailable' }
}

// 预留 → 校验 → 结算。只把 Redis 的异常转成 unavailable; check 里的数据库异常照常抛出
const withinStepUpBudget = async (
  uid: number,
  ip: string,
  check: () => Promise<SecondFactorResult>
): Promise<SecondFactorResult> => {
  const dims = stepUpSecondFactorDims(uid, ip)

  let reservation
  try {
    reservation = await reserveAttempt(dims)
  } catch (error) {
    return unavailable('reserve', error)
  }
  if (!reservation.allowed) {
    return { ok: false, reason: 'locked' }
  }

  const result = await check()
  if (result.ok) {
    // 证明已经成立: 清不掉计数只是此前的失败没被勾销, 不能因此判失败
    await settleSuccess(dims).catch((error) => unavailable('settle', error))
  }
  return result
}

const checkTotpResult = async (
  uid: number,
  storedSecret: string,
  code: string
): Promise<SecondFactorResult> => {
  let outcome
  try {
    outcome = await checkTotp(uid, storedSecret, code)
  } catch (error) {
    return unavailable('totp', error)
  }
  return outcome === 'ok' ? { ok: true } : { ok: false, reason: outcome }
}

// 已启用 2FA 的账号的二次验证: TOTP 或一个备份码。
// 备份码在这里只校验、不消费: 它由随后的状态变更在自己的事务里消费 (stepUp.ts 的
// consumeStepUpBackupCode), 变更没做成就不该白白作废 —— 备份码只有 10 个, 用它的人多半
// 已经没有身份验证器了。TOTP 的时间步则当场登记, 失败了等下一个码即可
export const verifySecondFactor = (
  uid: number,
  proof: SecondFactorProof,
  ctx: SecondFactorContext
) =>
  withinStepUpBudget(uid, ctx.ip, async () => {
    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: {
        enable_2fa: true,
        two_factor_secret: true,
        two_factor_backup: true
      }
    })
    if (!user?.enable_2fa) {
      return { ok: false, reason: 'invalid' }
    }

    if (proof.kind === 'backup') {
      return matchesTwoFactorBackupCode(user.two_factor_backup, proof.code)
        ? { ok: true }
        : { ok: false, reason: 'invalid' }
    }
    if (!user.two_factor_secret) {
      return { ok: false, reason: 'invalid' }
    }
    return checkTotpResult(uid, user.two_factor_secret, proof.code)
  })

// 启用之前确认用户的身份验证器已经装上这把密钥: 密钥还没生效, 由调用方把库里存的值原样传入
export const verifyEnrollmentCode = (
  uid: number,
  storedSecret: string,
  code: string,
  ctx: Pick<SecondFactorContext, 'ip'>
) =>
  withinStepUpBudget(uid, ctx.ip, () =>
    checkTotpResult(uid, storedSecret, code)
  )

// TOTP 种子唯一的生成点: secret 与 url 只在生成时给用户看一次 (二维码), stored 是落库的密文
export const createTotpKey = (issuer: string, user: string) => {
  const { secret, url } = Totp.generateKey({ issuer, user })
  return { secret, url, stored: totpSecretBox.seal(secret) }
}

// 备份码唯一的生成点: plain 只在启用时给用户看一次, stored 是落库的 HMAC
export const issueBackupCodes = () => {
  const plain = generateBackupCodes(BACKUP_CODE_COUNT, BACKUP_CODE_LENGTH)
  return { plain, stored: plain.map(hashTwoFactorBackupCode) }
}
