import { prisma } from '~/prisma/index'
import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { hashPassword, verifyPassword } from '~/app/api/utils/algorithm'
import { deleteKunToken } from '~/app/api/utils/jwt'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { passwordSchema } from '~/validations/user'

const updatePassword = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, passwordSchema)
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

  const user = await prisma.user.findUnique({ where: { id: payload.uid } })
  const res = await verifyPassword(input.oldPassword, user ? user.password : '')
  if (!res) {
    return '旧密码输入错误'
  }

  const hashedPassword = await hashPassword(input.newPassword)

  await prisma.user.update({
    where: { id: payload.uid },
    data: { password: hashedPassword }
  })

  await deleteKunToken(payload.uid)
  const cookie = await cookies()
  cookie.delete('kun-galgame-patch-moe-token')
}

export const POST = async (req: NextRequest) => {
  const res = await updatePassword(req)
  if (typeof res === 'string') {
    return NextResponse.json(res)
  }
  return NextResponse.json({})
}
