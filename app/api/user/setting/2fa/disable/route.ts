import { NextRequest, NextResponse } from 'next/server'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { getRemoteIp } from '~/app/api/utils/getRemoteIp'
import { disableUser2FASchema } from '~/validations/user'
import { kunTx } from '~/server/db/tx'
import { requireStepUp, STEP_UP_BACKUP_CODE_GONE } from '~/server/auth/stepUp'
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

  const stepUp = await requireStepUp(
    payload.uid,
    'twoFactor.disable',
    input.isBackupCode ? { backupCode: input.token } : { totp: input.token },
    { ip: getRemoteIp(req.headers) }
  )
  if (!stepUp.ok) {
    return NextResponse.json(stepUp.message)
  }

  // 备份码的消费与关闭在同一个事务里, 不能分开提交
  const failure = await kunTx('twoFactor.disable', async (ctx) => {
    const outcome = await disableTwoFactor(stepUp.passed, ctx.tx)
    if (outcome === 'backup-code-gone') {
      ctx.fail(STEP_UP_BACKUP_CODE_GONE)
    }
    if (outcome === 'not-enabled') {
      ctx.fail(TWO_FACTOR_STATE_CHANGED)
    }
  })

  return NextResponse.json(failure ?? { success: true, message: '2FA 已禁用' })
}
