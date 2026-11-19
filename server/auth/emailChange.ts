import { createHash, randomBytes } from 'crypto'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { consumeStepUpBackupCode, STEP_UP_BACKUP_CODE_GONE } from './stepUp'
import { applyKunCredentialChange } from './securityEvents'
import type { StepUpPassed } from './stepUp'

// 自助改邮箱的台账 (user_email_change, 一行是一次变更) 与建立在它上面的两条规则:
//
//   冷却: 24 小时内只允许一次自助变更, 已撤销的那次也算。撤销状态此前是一条按随机 token
//         寻址的 Redis 记录, 库里没有按用户的变更状态: 入侵者连续改两次邮箱, 发往最初邮箱
//         的撤销链接就命中 0 行而作废。有了冷却第二跳直接被拒, 那条链接在有效期内始终可用;
//   撤销: 原邮箱的持有者凭信里的令牌把邮箱改回去, 路由随后吊销该账号的全部会话。
//
// 冷却的判定与 email 列的条件更新在同一个事务、同一把 user 行锁之下, 所以放在数据库里而
// 不是 Redis: 那边带 TTL 的键在内存压力下会被驱逐, 而撤销记录是账号被入侵后唯一的自助
// 恢复手段。管理员在后台改邮箱不写台账。
//
// 发通知、验邮箱验证码、吊销会话都在路由那一层 (本目录不反向导入 app)。事务里没有网络 I/O

// 冷却期与撤销链接的有效期是同一个 24 小时
const WINDOW_MS = 24 * 60 * 60 * 1000

export const EMAIL_CHANGE_COOLDOWN_MESSAGE =
  '24 小时内只能修改一次邮箱, 请稍后再试'

const hashRevertToken = (token: string) =>
  createHash('sha256').update(token).digest('hex')

// 明文令牌只进发往旧邮箱的那封信, 库里只存它的哈希
export const issueRevertToken = () => {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashRevertToken(token) }
}

const cooldownStart = (now: Date) => new Date(now.getTime() - WINDOW_MS)

// 发通知之前的预检, 省得冷却期内每试一次就给当前邮箱发一封带死链接的提醒。
// 不是权威判定: 并发的两次变更都可能通过这里, 由 commitEmailChange 在行锁下再判
export const isEmailChangeCoolingDown = async (uid: number) => {
  const recent = await prisma.user_email_change.findFirst({
    where: { user_id: uid, created: { gt: cooldownStart(new Date()) } },
    select: { id: true }
  })
  return !!recent
}

// 返回失败文案; 成功返回这次写下的安全戳 (策略不刷新时为 null), 交给 finishKunSecurityEvent。
// 唯一约束冲突 (新邮箱刚被别人占用) 照常抛出
export const commitEmailChange = (
  passed: StepUpPassed<'email.change'>,
  change: { oldEmail: string; newEmail: string; revertTokenHash: string }
) => {
  const now = new Date()
  return kunTx('email.change', async (ctx) => {
    // 以旧邮箱为条件: 并发的两次变更只有一个命中, 另一个等到行锁后重新判定落空
    const updated = await applyKunCredentialChange(ctx.tx, {
      uid: passed.uid,
      event: 'email-changed',
      where: { email: change.oldEmail },
      data: { email: change.newEmail }
    })
    if (!updated.count) {
      ctx.fail('账户邮箱已发生变化, 请刷新后重试')
    }

    // 此刻持有 user 行锁: 同一账号的另一笔变更要么已提交 (这里查得到), 要么排在后面
    const recent = await ctx.tx.user_email_change.findFirst({
      where: { user_id: passed.uid, created: { gt: cooldownStart(now) } },
      select: { id: true }
    })
    if (recent) {
      ctx.fail(EMAIL_CHANGE_COOLDOWN_MESSAGE)
    }

    // 用备份码证明的, 到这一步才消费: 前面任何一处没过, 备份码都还在
    if (!(await consumeStepUpBackupCode(passed, ctx.tx))) {
      ctx.fail(STEP_UP_BACKUP_CODE_GONE)
    }

    await ctx.tx.user_email_change.create({
      data: {
        user_id: passed.uid,
        old_email: change.oldEmail,
        new_email: change.newEmail,
        revert_token_hash: change.revertTokenHash,
        created: now,
        expires: new Date(now.getTime() + WINDOW_MS)
      }
    })
    return { stamp: updated.stamp }
  })
}

const findRevertible = async (token: string, now: Date) => {
  const row = await prisma.user_email_change.findUnique({
    where: { revert_token_hash: hashRevertToken(token) }
  })
  return row && !row.reverted && row.expires > now ? row : null
}

// 撤销确认页用: 令牌有效时返回将要恢复的旧邮箱
export const findRevertibleEmailChange = async (token: string) => {
  const row = await findRevertible(token, new Date())
  return row ? { oldEmail: row.old_email } : null
}

export type EmailChangeRevert =
  | { status: 'reverted'; uid: number; oldEmail: string }
  // 令牌不存在、已过期或已经用过
  | { status: 'not-found' }
  // 账号的邮箱已经不是这次变更后的邮箱 (冷却期内只可能是管理员改过)
  | { status: 'superseded' }

// 旧邮箱已被别的账号占用时唯一约束冲突照常抛出, 由路由回「请联系管理员」
export const revertEmailChange = async (
  token: string
): Promise<EmailChangeRevert> => {
  const now = new Date()
  const row = await findRevertible(token, now)
  if (!row) {
    return { status: 'not-found' }
  }

  const failure = await kunTx('email.revert', async (ctx) => {
    // 先认领台账行: 同一个令牌并发提交两次, 后到的在这里落空
    const claimed = await ctx.tx.user_email_change.updateMany({
      where: { id: row.id, reverted: null },
      data: { reverted: now }
    })
    if (!claimed.count) {
      ctx.fail('not-found')
    }

    const restored = await applyKunCredentialChange(ctx.tx, {
      uid: row.user_id,
      event: 'email-reverted',
      where: { email: row.new_email },
      data: { email: row.old_email }
    })
    if (!restored.count) {
      // 回滚后台账行仍是未撤销: 管理员把邮箱改回这次变更后的值时, 链接还能用
      ctx.fail('superseded')
    }
  })

  if (failure === 'not-found' || failure === 'superseded') {
    return { status: failure }
  }
  return { status: 'reverted', uid: row.user_id, oldEmail: row.old_email }
}

// 过渡 (与撤销路由里读 Redis 的那一段一起删): 台账上线之前的那次变更, 状态只在 Redis 里,
// 冷却看不到它。账号若在上线之后又从那次变更后的邮箱改走了一次, 发往最初邮箱的旧链接照样
// 把邮箱恢复回去, 并把后面那一跳记为已撤销 —— 否则跨上线边界的两跳仍会让第一条链接作废
export const revertLegacyEmailChange = async (legacy: {
  uid: number
  oldEmail: string
  newEmail: string
}): Promise<EmailChangeRevert> => {
  const now = new Date()
  const failure = await kunTx('email.revertLegacy', async (ctx) => {
    const direct = await applyKunCredentialChange(ctx.tx, {
      uid: legacy.uid,
      event: 'email-reverted',
      where: { email: legacy.newEmail },
      data: { email: legacy.oldEmail }
    })
    if (direct.count) {
      return
    }

    const next = await ctx.tx.user_email_change.findFirst({
      where: {
        user_id: legacy.uid,
        old_email: legacy.newEmail,
        reverted: null
      },
      orderBy: { id: 'desc' }
    })
    if (!next) {
      return ctx.fail('superseded')
    }
    const claimed = await ctx.tx.user_email_change.updateMany({
      where: { id: next.id, reverted: null },
      data: { reverted: now }
    })
    const chained = await applyKunCredentialChange(ctx.tx, {
      uid: legacy.uid,
      event: 'email-reverted',
      where: { email: next.new_email },
      data: { email: legacy.oldEmail }
    })
    if (!claimed.count || !chained.count) {
      ctx.fail('superseded')
    }
  })

  return failure === 'superseded'
    ? { status: 'superseded' }
    : { status: 'reverted', uid: legacy.uid, oldEmail: legacy.oldEmail }
}
