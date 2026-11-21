import { generateChallenge } from 'capjs-core'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { KUN_CAP_CHALLENGE_SCOPE } from '~/constants/captcha'

// Cap widget 的挑战签发端点。挑战是 HMAC 签名的 JWT, 签发零存储,
// 响应格式遵循 Cap 协议, 由 cap-widget 的求解引擎消费 (components/kun/auth/useKunCap.ts)
// capjs-core 0.1.9 起三个 challenge* 参数都不传时默认签发 format 2 (HashWX),
// 而 redeem 的 capRedeemSchema 只接受 format 1 的数字答案; 显式写出原默认值锁定 format 1
export const POST = kunRoute.post({
  auth: 'public',
  handler: () =>
    generateChallenge(process.env.KUN_CAP_SECRET!, {
      scope: KUN_CAP_CHALLENGE_SCOPE,
      challengeCount: 50,
      challengeSize: 32,
      challengeDifficulty: 4
    })
})
