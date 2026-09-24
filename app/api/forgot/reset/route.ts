import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { forgotPasswordResetSchema } from '~/validations/forgot'
import { prisma } from '~/prisma/index'
import { hashPassword } from '~/app/api/utils/algorithm'
import { deleteKunToken } from '~/app/api/utils/jwt'
import { getKv, delKv } from '~/lib/redis'
import {
  createForgotPasswordResetKey,
  type ForgotPasswordResetPayload
} from '~/app/api/utils/sendResetPasswordLinkEmail'

const INVALID_LINK_MESSAGE = '重置链接无效或已过期, 请重新发起重置密码请求'

const resetPassword = async (
  input: z.infer<typeof forgotPasswordResetSchema>
) => {
  if (input.newPassword !== input.confirmPassword) {
    return '两次密码输入不一致'
  }

  const resetKey = createForgotPasswordResetKey(input.token)
  const stored = await getKv(resetKey)
  if (!stored) {
    return INVALID_LINK_MESSAGE
  }
  await delKv(resetKey)

  const payload: ForgotPasswordResetPayload = JSON.parse(stored)
  const user = await prisma.user.findUnique({
    where: { id: payload.uid }
  })
  if (!user || user.email.toLowerCase() !== payload.email.toLowerCase()) {
    return INVALID_LINK_MESSAGE
  }

  const hashedPassword = await hashPassword(input.newPassword)
  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashedPassword }
  })

  await deleteKunToken(user.id)
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, forgotPasswordResetSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const response = await resetPassword(input)
  if (typeof response === 'string') {
    return NextResponse.json(response)
  }

  return NextResponse.json({})
}
