import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '~/prisma/index'
import { finishKunSecurityEvent } from '~/server/auth/securityEvents'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { kunTx } from '~/server/db/tx'
import { disableTwoFactor } from '~/server/auth/twoFactorState'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { adminDisableUser2FASchema } from '~/validations/admin'
import { can } from '~/constants/permission'

const disableUser2FAByAdmin = async (
  input: { uid: number },
  adminUid: number
) => {
  const user = await prisma.user.findUnique({
    where: { id: input.uid },
    select: {
      id: true,
      name: true,
      enable_2fa: true
    }
  })
  if (!user) {
    return '未找到该用户'
  }
  if (!user.enable_2fa) {
    return '该用户尚未启用两步验证'
  }

  const admin = await prisma.user.findUnique({
    where: { id: adminUid },
    select: {
      id: true,
      name: true
    }
  })
  if (!admin) {
    return '未找到该管理员'
  }

  const failure = await kunTx('admin.user.twoFactor.disable', async (ctx) => {
    const disabled = await disableTwoFactor(
      { kind: 'admin-override', adminUid, uid: input.uid },
      ctx.tx
    )
    if (disabled.outcome !== 'disabled') {
      ctx.fail('该用户尚未启用两步验证')
    }

    await ctx.tx.admin_log.create({
      data: {
        type: 'update',
        user_id: adminUid,
        content: `管理员 ${admin.name} 关闭了用户 ${user.name} (${user.id}) 的两步验证`
      }
    })
  })
  if (failure) {
    return failure
  }

  await finishKunSecurityEvent(input.uid, '2fa-disabled-by-admin')
  return {}
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, adminDisableUser2FASchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const response = await disableUser2FAByAdmin(input, payload.uid)
  return NextResponse.json(response)
}
