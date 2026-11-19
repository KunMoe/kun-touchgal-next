import { NextRequest } from 'next/server'
import { delKv, getKv } from '~/lib/redis'
import { finishKunSecurityEvent } from '~/server/auth/securityEvents'
import {
  findRevertibleEmailChange,
  revertEmailChange,
  revertLegacyEmailChange
} from '~/server/auth/emailChange'
import type { EmailChangeRevert } from '~/server/auth/emailChange'
import {
  createEmailChangeRevertConfirmResponse,
  createEmailChangeRevertKey,
  createEmailChangeRevertResponse,
  type EmailChangeRevertPayload
} from '../_emailChange'

const invalidLink = () =>
  createEmailChangeRevertResponse(
    '撤销链接无效',
    '链接缺少必要的撤销令牌。',
    400
  )

const expiredLink = () =>
  createEmailChangeRevertResponse(
    '撤销链接已失效',
    '该链接不存在、已经使用过, 或已超过 24 小时有效期。',
    400
  )

// 旧邮箱在这期间被别的账号占用了: 重试没有用, 只能找管理员
const oldEmailTaken = () =>
  createEmailChangeRevertResponse(
    '撤销失败',
    '无法恢复旧邮箱: 它已被其他账户使用, 请联系管理员处理。',
    500
  )

// 其它失败不消耗链接, 可以重试
const revertFailed = () =>
  createEmailChangeRevertResponse(
    '撤销失败',
    '暂时无法恢复旧邮箱, 请稍后重新打开邮件里的撤销链接。',
    500
  )

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'P2002'

const getTokenFromBody = async (req: NextRequest) => {
  const contentType = req.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => null)
    return typeof body?.token === 'string' ? body.token.trim() : ''
  }

  const formData = await req.formData().catch(() => null)
  const token = formData?.get('token')
  return typeof token === 'string' ? token.trim() : ''
}

// 过渡: 台账 (user_email_change) 上线之前发出的撤销链接, 状态还在 Redis 里, 最长活 24 小时。
// 台账里查不到的令牌回落到这里。上线满 24 小时并再发一版之后, 把本函数、两处对它的调用、
// server/auth/emailChange.ts 的 revertLegacyEmailChange 连同 _emailChange.ts 里的
// createEmailChangeRevertKey / EmailChangeRevertPayload 一起删掉
const getLegacyRevertPayload = async (token: string) => {
  const revertKey = createEmailChangeRevertKey(token)
  const value = await getKv(revertKey)
  if (!value) {
    return { payload: null, revertKey }
  }

  try {
    const payload = JSON.parse(value) as EmailChangeRevertPayload
    const isValid =
      typeof payload.uid === 'number' &&
      typeof payload.oldEmail === 'string' &&
      typeof payload.newEmail === 'string' &&
      typeof payload.createdAt === 'string'
    return { payload: isValid ? payload : null, revertKey }
  } catch {
    return { payload: null, revertKey }
  }
}

export const GET = async (req: NextRequest) => {
  const token = new URL(req.url).searchParams.get('token')?.trim() || ''
  if (!token) {
    return invalidLink()
  }

  const change = await findRevertibleEmailChange(token)
  if (change) {
    return createEmailChangeRevertConfirmResponse(token, change.oldEmail)
  }

  const { payload } = await getLegacyRevertPayload(token)
  if (!payload) {
    return expiredLink()
  }
  return createEmailChangeRevertConfirmResponse(token, payload.oldEmail)
}

export const POST = async (req: NextRequest) => {
  const token = await getTokenFromBody(req)
  if (!token) {
    return invalidLink()
  }

  let result: EmailChangeRevert
  try {
    result = await revertEmailChange(token)
    if (result.status === 'not-found') {
      const legacy = await getLegacyRevertPayload(token)
      if (!legacy.payload) {
        return expiredLink()
      }
      result = await revertLegacyEmailChange(legacy.payload)
      await delKv(legacy.revertKey)
    }
  } catch (error) {
    return isUniqueViolation(error) ? oldEmailTaken() : revertFailed()
  }

  if (result.status !== 'reverted') {
    return createEmailChangeRevertResponse(
      '无需撤销',
      '账户邮箱当前不是这次变更后的邮箱, 可能已由管理员修改。如有疑问请联系管理员。',
      400
    )
  }

  // 邮箱已经改回来了。把这个账号的全部会话登出: 改走邮箱的人手里多半还握着一个
  try {
    await finishKunSecurityEvent(result.uid, 'email-reverted')
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to revoke sessions after email revert', error)
    return createEmailChangeRevertResponse(
      '邮箱已恢复',
      `账户邮箱已恢复为 ${result.oldEmail}, 但登出该账户的现有登录会话时出错。请立即修改密码 (修改密码会登出全部会话) 并检查 2FA 设置。`
    )
  }

  return createEmailChangeRevertResponse(
    '邮箱已恢复',
    `账户邮箱已恢复为 ${result.oldEmail}, 该账户的全部登录会话已被登出。建议您立即修改密码并检查 2FA 设置。`
  )
}
