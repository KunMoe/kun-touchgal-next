import { NextRequest, NextResponse } from 'next/server'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { disableUser2FASchema } from '~/validations/user'
import { kunTx } from '~/server/db/tx'
import { requireStepUp } from '~/server/auth/stepUp'
import {
  disableTwoFactor,
  TWO_FACTOR_STATE_CHANGED
} from '~/server/auth/twoFactorState'

export const POST = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const input = await kunParsePostBody(req, disableUser2FASchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const ip = getRemoteIp(req.headers)
  // 二次验证与关闭在同一个事务里: 备份码的消费不能与关闭分开提交
  const failure = await kunTx('twoFactor.disable', async (ctx) => {
    const stepUp = await requireStepUp(
      payload.uid,
      'twoFactor.disable',
      input.isBackupCode ? { backupCode: input.token } : { totp: input.token },
      { ip, db: ctx.tx }
    )
    if (!stepUp.ok) {
      return ctx.fail(stepUp.message)
    }
    if (!(await disableTwoFactor(stepUp.passed, ctx.tx))) {
      ctx.fail(TWO_FACTOR_STATE_CHANGED)
    }
  })

  return NextResponse.json(failure ?? { success: true, message: '2FA 已禁用' })
}
