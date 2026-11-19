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
import { finishKunSecurityEvent } from '~/server/auth/securityEvents'
import { tokenStampOf } from '~/server/auth/securityStamp'

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
  const result = await kunTx('twoFactor.disable', async (ctx) => {
    const disabled = await disableTwoFactor(
      stepUp.passed,
      ctx.tx,
      tokenStampOf(payload)
    )
    if (disabled.outcome !== 'disabled') {
      return ctx.fail(
        disabled.outcome === 'backup-code-gone'
          ? STEP_UP_BACKUP_CODE_GONE
          : TWO_FACTOR_STATE_CHANGED
      )
    }
    return { stamp: disabled.stamp }
  })
  if (typeof result === 'string') {
    return NextResponse.json(result)
  }

  await finishKunSecurityEvent(payload.uid, '2fa-disabled', {
    current: payload,
    stamp: result.stamp
  })
  return NextResponse.json({ success: true, message: '2FA 已禁用' })
}
