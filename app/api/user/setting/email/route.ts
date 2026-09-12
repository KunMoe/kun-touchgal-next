import { prisma } from '~/prisma/index'
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { Totp } from 'time2fa'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { verifyVerificationCode } from '~/app/api/utils/verifyVerificationCode'
import { resetEmailSchema } from '~/validations/user'
import { verifyPassword } from '~/app/api/utils/algorithm'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { delKv, setKv } from '~/lib/redis'
import {
  createEmailChangeRevertKey,
  EMAIL_CHANGE_REVERT_TTL_SECONDS,
  sendEmailChangeNotification,
  type EmailChangeRevertPayload
} from './_emailChange'

type ResetEmailInput = {
  email: string
  code: string
  currentPassword?: string
  totp?: string
}

type EmailChangeUser = {
  id: number
  email: string
  password: string
  enable_2fa: boolean
  two_factor_secret: string
}

type PreviousEmailNoticeResult =
  { error: string; revertKey?: never } | { error?: never; revertKey: string }

const getEmailChangeUser = async (uid: number) => {
  return prisma.user.findUnique({
    where: { id: uid },
    select: {
      id: true,
      email: true,
      password: true,
      enable_2fa: true,
      two_factor_secret: true
    }
  })
}

const validateEmailChangeTarget = async (
  user: EmailChangeUser,
  email: string
) => {
  if (email === user.email) {
    return '新邮箱不能与当前邮箱相同'
  }

  const existedUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true }
  })
  if (existedUser && existedUser.id !== user.id) {
    return '该邮箱已被使用'
  }
}

const verifyTotpChallenge = (user: EmailChangeUser, token?: string) => {
  if (!user.two_factor_secret) {
    return '未找到 2FA 密钥'
  }

  if (!token) {
    return '请输入 2FA 验证码'
  }

  const isTotpValid = Totp.validate({
    passcode: token,
    secret: user.two_factor_secret
  })
  if (!isTotpValid) {
    return '2FA 验证码无效'
  }
}

const verifyPasswordChallenge = async (
  user: EmailChangeUser,
  currentPassword?: string
) => {
  if (!currentPassword) {
    return '请输入当前密码'
  }

  const isPasswordValid = await verifyPassword(currentPassword, user.password)
  if (!isPasswordValid) {
    return '当前密码输入错误'
  }
}

const verifyEmailChangeChallenge = async (
  user: EmailChangeUser,
  input: ResetEmailInput
) => {
  if (user.enable_2fa) {
    return verifyTotpChallenge(user, input.totp)
  }

  return verifyPasswordChallenge(user, input.currentPassword)
}

const createRevertToken = async (user: EmailChangeUser, newEmail: string) => {
  const revertToken = randomUUID()
  const revertPayload: EmailChangeRevertPayload = {
    uid: user.id,
    oldEmail: user.email,
    newEmail,
    createdAt: new Date().toISOString()
  }
  const revertKey = createEmailChangeRevertKey(revertToken)

  await setKv(
    revertKey,
    JSON.stringify(revertPayload),
    EMAIL_CHANGE_REVERT_TTL_SECONDS
  )

  return { revertKey, revertToken }
}

const sendPreviousEmailNotice = async (
  user: EmailChangeUser,
  newEmail: string
): Promise<PreviousEmailNoticeResult> => {
  const { revertKey, revertToken } = await createRevertToken(user, newEmail)
  const noticeResult = await sendEmailChangeNotification(
    user.email,
    newEmail,
    revertToken
  ).catch(() => '发送旧邮箱安全通知失败, 请稍后重试')

  if (noticeResult) {
    await delKv(revertKey)
    return { error: noticeResult }
  }

  return { revertKey }
}

const commitEmailChange = async (
  uid: number,
  email: string,
  revertKey: string
) => {
  try {
    await prisma.user.update({
      where: { id: uid },
      data: { email }
    })
    await delKv(email).catch(() => undefined)
  } catch {
    await delKv(revertKey)
    return '更新邮箱失败, 请稍后重试'
  }
}

const updateEmail = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, resetEmailSchema)
  if (typeof input === 'string') {
    return input
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return '用户未登录'
  }
  if (!getRemoteIp(req.headers)) {
    return '读取请求头失败'
  }

  const user = await getEmailChangeUser(payload.uid)
  if (!user) {
    return '用户不存在'
  }

  const targetError = await validateEmailChangeTarget(user, input.email)
  if (targetError) {
    return targetError
  }

  const challengeError = await verifyEmailChangeChallenge(user, input)
  if (challengeError) {
    return challengeError
  }

  const isCodeValid = await verifyVerificationCode(input.email, input.code)
  if (!isCodeValid) {
    return '您的验证码无效, 请重新输入'
  }

  const notice = await sendPreviousEmailNotice(user, input.email)
  if (notice.error) {
    return notice.error
  }
  if (!notice.revertKey) {
    return '发送旧邮箱安全通知失败, 请稍后重试'
  }

  return commitEmailChange(payload.uid, input.email, notice.revertKey)
}

export const POST = async (req: NextRequest) => {
  const res = await updateEmail(req)
  if (typeof res === 'string') {
    return NextResponse.json(res)
  }
  return NextResponse.json({})
}
