import { createHash } from 'crypto'
import type { BudgetDimension } from './attemptBudget'

// 尝试预算按「被猜的秘密 × 入口面」分桶。
//
// 秘密分两份: 第二因子 (TOTP 与备份码共用一个桶, 否则换一种码就多一份额度) 和当前密码。
// 入口面分两种: 登录 (要先过密码与人机验证) 和已登录后的二次验证 (要先持有会话)。两个入口面
// 刻意不共桶: 如果设置页复用登录的 uid 键, 持被窃会话的人可以先吊销受害者的其它会话, 再在
// 设置页烧光额度, 受害者就无法通过 2FA 重新登录。
//
// 设置页的 uid 桶仍可被会话窃取者耗尽, 受害者 15 分钟内过不了二次验证; 但「吊销其它会话」
// 不要求二次验证, 找回密码也不经这里, 所以锁定是有界的。

const STEP_UP_WINDOW_SECONDS = 15 * 60
const STEP_UP_UID_LIMIT = 10
const STEP_UP_UID_IP_LIMIT = 5

// IP 只进键名的摘要; 取不到 IP 时不设这个维度
const stepUpDims = (
  secret: '2fa' | 'pw',
  uid: number,
  ip: string
): BudgetDimension[] => [
  {
    key: `auth:stepup:${secret}:uid:${uid}`,
    limit: STEP_UP_UID_LIMIT,
    windowSeconds: STEP_UP_WINDOW_SECONDS
  },
  ...(ip
    ? [
        {
          key: `auth:stepup:${secret}:uid-ip:${uid}:${createHash('sha256').update(ip).digest('hex')}`,
          limit: STEP_UP_UID_IP_LIMIT,
          windowSeconds: STEP_UP_WINDOW_SECONDS
        }
      ]
    : [])
]

export const stepUpSecondFactorDims = (uid: number, ip: string) =>
  stepUpDims('2fa', uid, ip)

export const stepUpPasswordDims = (uid: number, ip: string) =>
  stepUpDims('pw', uid, ip)
