import type { KunCapability } from '~/constants/permission'

// 写入口的频率预算表 (T12)。一次请求的成本由别人承担的入口在这里各占一行: 审核队列与
// 审核供应商、其他用户的收件箱、管理员收件箱、整站共用的上游配额。凭据类的尝试预算不在
// 这里 (server/auth/budgets.ts)。
//
// 新增一种预算 = 这里加一行 + 入口加一处引用 (kunRoute 的 abuse 字段, 或属主处调
// reserveAbuseBudget)。__tests__/policies.test.ts 要求每行至少被引用一次。
//
// 取值: 初值按生产数据副本 (截至 2026-09-18) 里每个账号的历史峰值 (滑动窗口, 全部历史)
// 留出约 1.5 到 2.5 倍余量, 各行注释里是那个峰值; 外部抓取没有可查的历史, 是估的。观察期里
// 超限只记统计, 一周后按统计逐行改成 enforce。
// 线上止损不用重新构建: SET kun:touchgal:abuse:override:<策略名> off (这行既不检查也不计数),
// 观察统计: HGETALL kun:touchgal:abuse:stats:<策略名>:<UTC 日期>

export interface KunAbuseWindow {
  // uid: 每个账号一份; global: 全站共用一份 (按 IP 的维度要等 T23 定下可信代理之后)
  per: 'uid' | 'global'
  limit: number
  windowSeconds: number
}

export interface KunAbusePolicy {
  windows: readonly KunAbuseWindow[]
  // 有这项能力的人不受这行约束 (管理员的入口本身是特权入口)。整站共用的上游配额不看谁在
  // 用, 写 null
  exempt: KunCapability | null
  // observe: 超限照常放行, 只记进当日统计; enforce: 超限拒绝
  mode: 'observe' | 'enforce'
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const KUN_ABUSE_POLICIES = {
  // 评论: 送审, 带提及扇出与回复通知。峰值 10 分钟 13 条, 24 小时 42 条
  'content.comment': {
    windows: [
      { per: 'uid', limit: 20, windowSeconds: 10 * MINUTE },
      { per: 'uid', limit: 100, windowSeconds: DAY }
    ],
    exempt: 'abuse.exempt',
    mode: 'observe'
  },
  // 评价: 每部作品只能评一次, 但跨作品无界; 送审。有成批补评的老用户: 峰值 10 分钟 40 条,
  // 24 小时 359 条
  'content.rating': {
    windows: [
      { per: 'uid', limit: 60, windowSeconds: 10 * MINUTE },
      { per: 'uid', limit: 500, windowSeconds: DAY }
    ],
    exempt: 'abuse.exempt',
    mode: 'observe'
  },
  // 评论与评价的举报共用一份: 都进管理员的待处理列表。峰值是一次成立的刷屏清理: 8 分钟
  // 31 条, 24 小时 98 条 (其次的人 24 小时 14 条)
  'report.create': {
    windows: [
      { per: 'uid', limit: 50, windowSeconds: HOUR },
      { per: 'uid', limit: 150, windowSeconds: DAY }
    ],
    exempt: 'abuse.exempt',
    mode: 'observe'
  },
  // 反馈: 每次都向管理员收件箱发一条, 不去重。峰值 1 小时 13 条
  'feedback.create': {
    windows: [
      { per: 'uid', limit: 20, windowSeconds: HOUR },
      { per: 'uid', limit: 40, windowSeconds: DAY }
    ],
    exempt: 'abuse.exempt',
    mode: 'observe'
  },
  // 开会话: 向任意用户开一个新收件箱 (全站没有用户屏蔽)。库里不记发起者, 按参与者计的
  // 峰值是 24 小时 5 个
  'conversation.open': {
    windows: [
      { per: 'uid', limit: 10, windowSeconds: HOUR },
      { per: 'uid', limit: 30, windowSeconds: DAY }
    ],
    exempt: 'abuse.exempt',
    mode: 'observe'
  },
  // 会话内发信。峰值是一段一对一聊天: 1 分钟 11 条, 24 小时 119 条
  'message.send': {
    windows: [
      { per: 'uid', limit: 30, windowSeconds: MINUTE },
      { per: 'uid', limit: 300, windowSeconds: DAY }
    ],
    exempt: 'abuse.exempt',
    mode: 'observe'
  },
  // 提及通知按真正新增的收件人计费 (cost = 人数), 即时发布与审核通过后的补发都经这里。
  // 峰值每天 4 人、单条评论 8 人; 一条评论提及的人超过 limit 时这条的提及永远发不出去
  'notify.mention': {
    windows: [{ per: 'uid', limit: 50, windowSeconds: DAY }],
    exempt: 'abuse.exempt',
    mode: 'observe'
  },
  // 外部元数据抓取 (五条 /api/edit/* 路由), 按账号; 另由下面的 upstream.* 管整站
  'external.fetch': {
    windows: [
      { per: 'uid', limit: 30, windowSeconds: 10 * MINUTE },
      { per: 'uid', limit: 300, windowSeconds: DAY }
    ],
    exempt: 'abuse.exempt',
    mode: 'observe'
  },
  // 上游按本站出口计的配额, 取它们公布或实测上限的一半左右
  'upstream.vndb': {
    windows: [{ per: 'global', limit: 100, windowSeconds: 5 * MINUTE }],
    exempt: null,
    mode: 'observe'
  },
  'upstream.bangumi': {
    windows: [{ per: 'global', limit: 100, windowSeconds: 5 * MINUTE }],
    exempt: null,
    mode: 'observe'
  },
  'upstream.steam': {
    windows: [{ per: 'global', limit: 100, windowSeconds: 5 * MINUTE }],
    exempt: null,
    mode: 'observe'
  },
  'upstream.dlsite': {
    windows: [{ per: 'global', limit: 60, windowSeconds: 5 * MINUTE }],
    exempt: null,
    mode: 'observe'
  },
  // 鲲补丁资源: 匿名可调, 整站共用一把每分钟 60 次的密钥; 只在缓存未命中、真要打上游时扣
  'upstream.moyu': {
    windows: [{ per: 'global', limit: 40, windowSeconds: MINUTE }],
    exempt: null,
    mode: 'observe'
  }
} as const satisfies Record<string, KunAbusePolicy>

export type KunAbusePolicyName = keyof typeof KUN_ABUSE_POLICIES
