import { NextResponse } from 'next/server'
import { validateChallenge } from 'capjs-core'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { generateCaptchaVerifyToken } from '~/app/api/utils/verifyKunCaptcha'
import { setKv, setKvIfAbsent } from '~/lib/redis'
import { capRedeemSchema } from '~/validations/captcha'
import {
  KUN_CAP_CHALLENGE_SCOPE,
  KUN_CAPTCHA_VERIFY_TOKEN_TTL_SECONDS
} from '~/constants/captcha'

// 响应遵循 Cap widget 协议 ({ success, token, expires }), 而非本项目的
// 字符串错误惯例; expires 为毫秒时间戳且必须距今 24h 内, 否则 widget 报错。
// 校验失败也要回协议形状, 所以请求体在 handler 里自己解析
export const POST = kunRoute.post({
  auth: 'public',
  handler: async ({ req }) => {
    const input = await kunParsePostBody(req, capRedeemSchema)
    if (typeof input === 'string') {
      return NextResponse.json({ success: false, error: input })
    }

    const result = await validateChallenge(
      process.env.KUN_CAP_SECRET!,
      { token: input.token, solutions: input.solutions },
      {
        scope: KUN_CAP_CHALLENGE_SCOPE,
        consumeNonce: (signatureHex, ttlMs) =>
          setKvIfAbsent(
            `captcha:nonce:${signatureHex}`,
            '1',
            Math.ceil(ttlMs / 1000)
          )
      }
    )
    if (!result.success) {
      return NextResponse.json({
        success: false,
        error: '人机验证失败, 请重试'
      })
    }

    const code = generateCaptchaVerifyToken()
    await setKv(
      `captcha:verify:${code}`,
      'captcha',
      KUN_CAPTCHA_VERIFY_TOKEN_TTL_SECONDS
    )

    return NextResponse.json({
      success: true,
      token: code,
      expires: Date.now() + KUN_CAPTCHA_VERIFY_TOKEN_TTL_SECONDS * 1000
    })
  }
})
