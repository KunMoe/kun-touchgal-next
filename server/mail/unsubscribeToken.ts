import { createHmac, timingSafeEqual } from 'crypto'
import { kunUnsubscribePageUrl } from '~/constants/email/campaign'

// 群发邮件里退订链接的能力令牌: 对 uid 的 HMAC, 不落任何存储。它不过期、不会被下一次群发
// 覆盖, 链接里也不带邮箱。退订是单向且幂等的 (登录后可以在设置页重新开启), 所以令牌不需要
// 撤销, 被转发出去的后果只是有人替收件人关掉了通知; 换密钥则全部作废。
// 长度与 validations/auth.ts 的 disableEmailNoticeSchema 一致
const TOKEN_LENGTH = 32

const getUnsubscribeSecret = () => {
  const secret = process.env.KUN_EMAIL_UNSUBSCRIBE_SECRET
  if (!secret) {
    throw new Error('KUN_EMAIL_UNSUBSCRIBE_SECRET is not configured')
  }
  return secret
}

export const signUnsubscribeToken = (uid: number) =>
  createHmac('sha256', getUnsubscribeSecret())
    .update(`email-unsubscribe:v1:${uid}`)
    .digest('base64url')
    .slice(0, TOKEN_LENGTH)

export const verifyUnsubscribeToken = (uid: number, token: string) => {
  const expected = Buffer.from(signUnsubscribeToken(uid))
  const given = Buffer.from(token)
  // timingSafeEqual 遇到长度不等的输入会抛错, 先比长度
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export const createUnsubscribeUrl = (uid: number) => {
  const url = new URL(kunUnsubscribePageUrl())
  url.searchParams.set('u', String(uid))
  url.searchParams.set('t', signUnsubscribeToken(uid))
  return url.toString()
}
