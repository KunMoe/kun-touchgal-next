import { prisma } from '~/prisma/index'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { finishKunSecurityEvent } from '~/server/auth/securityEvents'
import { verifyVerificationCode } from '~/app/api/utils/verifyVerificationCode'
import { resetEmailSchema } from '~/validations/user'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { delKv } from '~/lib/redis'
import { requireStepUp } from '~/server/auth/stepUp'
import {
  commitEmailChange,
  EMAIL_CHANGE_COOLDOWN_MESSAGE,
  isEmailChangeCoolingDown,
  issueRevertToken
} from '~/server/auth/emailChange'
import { sendEmailChangeNotification } from './_emailChange'

const NOTICE_FAILED = '发送旧邮箱安全通知失败, 请稍后重试'

const isEmailTaken = async (uid: number, email: string) => {
  const existedUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true }
  })
  return !!existedUser && existedUser.id !== uid
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

  const user = await prisma.user.findUnique({
    where: { id: payload.uid },
    select: { email: true }
  })
  if (!user) {
    return '用户不存在'
  }

  if (input.email === user.email) {
    return '新邮箱不能与当前邮箱相同'
  }

  // 冷却与邮箱验证码排在二次验证之前: 这两项只看账号自己的状态与请求本身, 不透露目标邮箱
  // 注册没有; 排在后面的话, 冷却期内或验证码输错一次, 刚用掉的 TOTP 时间步就白白作废
  if (await isEmailChangeCoolingDown(payload.uid)) {
    return EMAIL_CHANGE_COOLDOWN_MESSAGE
  }

  const isCodeValid = await verifyVerificationCode(input.email, input.code)
  if (!isCodeValid) {
    return '您的验证码无效, 请重新输入'
  }

  const stepUp = await requireStepUp(payload.uid, 'email.change', input, {
    ip
  })
  if (!stepUp.ok) {
    return stepUp.message
  }

  // 查重排在两道证明之后: 没证明身份、没收到新邮箱的验证码, 就问不出一个邮箱注册没有
  if (await isEmailTaken(payload.uid, input.email)) {
    return '该邮箱已被使用'
  }

  // 先通知旧邮箱, 发不出去就不改: 撤销链接是旧邮箱持有者唯一的自助恢复手段
  const revert = issueRevertToken()
  const noticeError = await sendEmailChangeNotification(
    user.email,
    input.email,
    revert.token
  ).catch(() => NOTICE_FAILED)
  if (noticeError) {
    return noticeError
  }

  let committed: Awaited<ReturnType<typeof commitEmailChange>>
  try {
    committed = await commitEmailChange(stepUp.passed, {
      oldEmail: user.email,
      newEmail: input.email,
      revertTokenHash: revert.hash
    })
  } catch {
    return '更新邮箱失败, 请稍后重试'
  }
  if (typeof committed === 'string') {
    return committed
  }

  await finishKunSecurityEvent(payload.uid, 'email-changed', {
    current: payload,
    stamp: committed.stamp
  })
  await delKv(input.email).catch(() => undefined)
}

export const POST = async (req: NextRequest) => {
  const res = await updateEmail(req)
  if (typeof res === 'string') {
    return NextResponse.json(res)
  }
  return NextResponse.json({})
}
