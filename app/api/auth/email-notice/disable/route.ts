import * as z from 'zod'
import { delKv, getKv } from '~/lib/redis'
import { prisma } from '~/prisma/index'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { disableEmailNoticeSchema } from '~/validations/auth'
import { invalidateUserSession } from '~/app/api/user/session/cache'

const CACHE_KEY = 'auth:mail:notice'

const disableEmailNotice = async (
  input: z.infer<typeof disableEmailNoticeSchema>
) => {
  const cacheEmailUUID = await getKv(`${CACHE_KEY}:${input.email}`)
  if (cacheEmailUUID !== input.validateEmailCode) {
    return '非法的邮箱验证码, 请您登录后在用户设置页面取消邮件订阅'
  }
  await delKv(`${CACHE_KEY}:${input.email}`)

  const user = await prisma.user.findUnique({
    where: { email: input.email }
  })
  if (!user) {
    return '未找到用户'
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { enable_email_notice: false }
  })
  await invalidateUserSession(user.id)
  return {}
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, disableEmailNoticeSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const res = await disableEmailNotice(input)
  return NextResponse.json(res)
}
