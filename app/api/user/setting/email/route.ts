import { prisma } from '~/prisma/index'
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { verifyVerificationCode } from '~/app/api/utils/verifyVerificationCode'
import { resetEmailSchema } from '~/validations/user'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { delKv, setKv } from '~/lib/redis'
import { requireStepUp } from '~/server/auth/stepUp'
import {
  createEmailChangeRevertKey,
  EMAIL_CHANGE_REVERT_TTL_SECONDS,
  sendEmailChangeNotification,
  type EmailChangeRevertPayload
} from './_emailChange'

type EmailChangeUser = {
  id: number
  email: string
}

type PreviousEmailNoticeResult =
  { error: string; revertKey?: never } | { error?: never; revertKey: string }

const getEmailChangeUser = async (uid: number) => {
  return prisma.user.findUnique({
    where: { id: uid },
    select: { id: true, email: true }
  })
}

const isEmailTaken = async (user: EmailChangeUser, email: string) => {
  const existedUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true }
  })
  return !!existedUser && existedUser.id !== user.id
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
  const ip = getRemoteIp(req.headers)
  if (!ip) {
    return '读取请求头失败'
  }

  const user = await getEmailChangeUser(payload.uid)
  if (!user) {
    return '用户不存在'
  }

  if (input.email === user.email) {
    return '新邮箱不能与当前邮箱相同'
  }

  const stepUp = await requireStepUp(payload.uid, 'email.change', input, {
    ip
  })
  if (!stepUp.ok) {
    return stepUp.message
  }

  const isCodeValid = await verifyVerificationCode(input.email, input.code)
  if (!isCodeValid) {
    return '您的验证码无效, 请重新输入'
  }

  // 查重排在两道证明之后: 没证明身份、没收到新邮箱的验证码, 就问不出一个邮箱注册没有
  if (await isEmailTaken(user, input.email)) {
    return '该邮箱已被使用'
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
