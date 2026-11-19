import { kunRoute } from '~/app/api/utils/kunRoute'
import { parseCookies } from '~/utils/cookies'
import { verify2FA } from '~/app/api/utils/verify2FA'
import { isTwoFactorChallengeActive } from '~/app/api/auth/_twoFactorChallenge'

// 认的是 2FA 临时令牌, 不是站点会话
export const GET = kunRoute.get({
  auth: 'public',
  handler: async ({ req }) => {
    const tempToken = parseCookies(req.headers.get('cookie') ?? '')[
      'kun-galgame-patch-moe-2fa-token'
    ]
    if (!tempToken) {
      return '未找到临时令牌'
    }

    const payload = verify2FA(tempToken)
    if (!payload) {
      return '2FA 临时令牌已过期, 时效为 10 分钟'
    }

    try {
      const isActive = await isTwoFactorChallengeActive(payload.jti, payload.id)
      if (!isActive) {
        return '2FA 临时令牌已失效, 请重新登录'
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to check 2FA challenge', error)
      return '2FA 验证服务暂不可用, 请稍后重试'
    }

    return payload
  }
})
