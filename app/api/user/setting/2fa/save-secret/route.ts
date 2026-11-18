import { prisma } from '~/prisma/index'
import { NextRequest, NextResponse } from 'next/server'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { toDataURL } from 'qrcode'
import { createTotpKey } from '~/server/auth/secondFactor'

const saveSecret = async (uid: number) => {
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { name: true, enable_2fa: true }
  })

  if (!user) {
    return '用户不存在'
  }

  if (user.enable_2fa) {
    return '请先关闭现有 2FA 后再重新设置'
  }

  const key = createTotpKey(kunMoyuMoe.titleShort, user.name || uid.toString())
  const qrCodeUrl = await toDataURL(key.url)

  const updateResult = await prisma.user.updateMany({
    where: { id: uid, enable_2fa: false },
    data: {
      two_factor_secret: key.secret,
      two_factor_backup: [],
      enable_2fa: false
    }
  })

  if (!updateResult.count) {
    return '当前 2FA 状态已变化，请刷新后重试'
  }

  return { secret: key.secret, authUrl: key.url, qrCodeUrl }
}

export const POST = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const result = await saveSecret(payload.uid)
  return NextResponse.json(result)
}
