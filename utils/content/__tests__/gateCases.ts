// 12 个内容闸门的期望结果表: 逐条转录自 T29 动手前的 HEAD (85b355ac) 各入口的事务外预检,
// 以及编辑 / 删除入口把行锁下被跳过的行映射成文案的那几行。
// 入口测试 (app/api/patch/*/__tests__/gate-matrix.test.ts) 拿它驱动真实的入口, 策略测试
// (utils/content/__tests__/policy.test.ts) 拿它比对 decideContentAction: 两边都对得上,
// 入口改调策略之前与之后的行为就逐格相同。
// 这里刻意写成与入口当时一样的分支, 不复用任何产品代码; 要改的只有「产品口径真的变了」

import { can } from '~/constants/permission'

export type GateKind = 'comment' | 'rating' | 'resource'
export type GateAction = 'like' | 'report' | 'reply' | 'edit' | 'delete'
export type GateKey = `${GateKind}.${GateAction}`

export interface GateViewer {
  name: string
  uid: number
  role: 1 | 2 | 3 | 4
}

export interface GateRow {
  status: number
  user_id: number
}

export const GATE_OWNER_UID = 7

export const GATE_VIEWERS: readonly GateViewer[] = [
  { name: 'owner-member', uid: GATE_OWNER_UID, role: 1 },
  { name: 'other-member', uid: 8, role: 1 },
  { name: 'owner-creator', uid: GATE_OWNER_UID, role: 2 },
  { name: 'owner-moderator', uid: GATE_OWNER_UID, role: 3 },
  { name: 'other-moderator', uid: 8, role: 3 },
  { name: 'other-superadmin', uid: 9, role: 4 }
]

// 三张表在 HEAD 上可达的全部取值
export const GATE_CODES: Record<GateKind, readonly number[]> = {
  comment: [0, 1, 2],
  rating: [0, 1, 2],
  resource: [0, 1, 2, 3]
}

// 编辑 / 删除他人内容的门槛。门槛本身归 constants/permission.ts (权限矩阵另有测试), 这里只引用
const moderates = (v: GateViewer) => can(v, 'content.moderateAny')

type GateFn = (
  r: GateRow | null,
  v: GateViewer,
  pendingTask: boolean
) => string | null

export const EXPECTED_GATE: Record<string, GateFn> = {
  // app/api/patch/comment/like/route.ts
  'comment.like': (r, v) => {
    if (!r) return '未找到评论'
    if (r.user_id === v.uid) return '您不能给自己点赞'
    if (r.status === 1) return '该评论正在审核中, 暂时无法点赞'
    if (r.status !== 0) return '未找到评论'
    return null
  },
  // app/api/patch/comment/report/route.ts (patch_id 的核对与状态无关, 夹具恒相等)
  'comment.report': (r, v) => {
    if (!r) return '评论不存在'
    if (r.user_id === v.uid) return '不能举报自己的评论'
    if (r.status === 1) return '该评论正在审核中, 暂时无法举报'
    if (r.status !== 0) return '评论不存在'
    return null
  },
  // app/api/patch/comment/create.ts 的父评论预检
  'comment.reply': (r) => {
    if (!r) return '未找到该评论'
    if (r.status === 1) return '该评论正在审核中, 暂时无法回复'
    if (r.status !== 0) return '未找到该评论'
    return null
  },
  // app/api/patch/comment/update.ts
  'comment.edit': (r, v, pendingTask) => {
    if (!r || r.status === 2) return '未找到该评论'
    if (r.user_id !== v.uid && !moderates(v)) return '您没有权限更改该评论'
    if (!moderates(v) && pendingTask)
      return '您发布的评论正在审核中, 暂时无法修改'
    if (!moderates(v) && r.status === 1)
      return '您发布的评论正在审核中, 暂时无法修改'
    return null
  },
  // app/api/patch/comment/delete.ts
  'comment.delete': (r, v) => {
    if (!r || r.status === 2) return '未找到对应的评论'
    if (r.user_id !== v.uid && !moderates(v)) return '您没有权限删除该评论'
    if (!moderates(v) && r.status === 1) return '该评论正在审核中, 暂时无法删除'
    return null
  },
  // app/api/patch/rating/like/route.ts
  'rating.like': (r, v) => {
    if (!r) return '评价不存在'
    if (r.user_id === v.uid) return '您不能给自己点赞'
    if (r.status === 1) return '该评价正在审核中, 暂时无法点赞'
    if (r.status !== 0) return '评价不存在'
    return null
  },
  // app/api/patch/rating/report/route.ts
  'rating.report': (r, v) => {
    if (!r) return '评价不存在'
    if (r.user_id === v.uid) return '不能举报自己的评价'
    if (r.status === 1) return '该评价正在审核中, 暂时无法举报'
    if (r.status !== 0) return '评价不存在'
    return null
  },
  // app/api/patch/rating/update.ts
  'rating.edit': (r, v, pendingTask) => {
    if (!r || r.status === 2) return '评价不存在'
    if (r.user_id !== v.uid && !moderates(v)) return '您没有权限更新该评价'
    if (!moderates(v) && pendingTask)
      return '您发布的评价正在审核中, 暂时无法修改'
    if (!moderates(v) && r.status === 1)
      return '您发布的评价正在审核中, 暂时无法修改'
    return null
  },
  // app/api/patch/rating/delete.ts
  'rating.delete': (r, v) => {
    if (!r || r.status === 2) return '评价不存在'
    if (r.user_id !== v.uid && !moderates(v)) return '您没有权限删除该评价'
    if (!moderates(v) && r.status === 1) return '该评价正在审核中, 暂时无法删除'
    return null
  },
  // app/api/patch/resource/like/route.ts
  'resource.like': (r, v) => {
    if (!r) return '未找到资源'
    if (r.user_id === v.uid) return '您不能给自己点赞'
    if (r.status === 2 || r.status === 3)
      return '该资源正在审核中, 暂时无法点赞'
    if (r.status !== 0) return '未找到资源'
    return null
  },
  // app/api/patch/resource/update.ts 的 resourceEditGuardError + 在途任务检查 (前台守卫)
  'resource.edit': (r, v, pendingTask) => {
    if (!r) return '未找到该资源'
    if (!moderates(v)) {
      if (r.status === 1) return '未找到该资源'
      if (r.user_id !== v.uid) return '您没有权限更改该资源'
      if (r.status === 2) return '您发布的资源正在等待管理员审核, 暂时无法修改'
      if (r.status === 3) return '您发布的资源正在审核中, 暂时无法修改'
      if (pendingTask) return '您发布的资源正在审核中, 暂时无法修改'
      return null
    }
    if (r.status === 1) return '未找到该资源'
    return null
  },
  // app/api/patch/resource/delete.ts
  'resource.delete': (r, v) => {
    if (!r || r.status === 1) return '未找到对应的资源'
    if (r.user_id !== v.uid && !moderates(v)) return '您没有权限删除该资源'
    if (!moderates(v) && r.status !== 0) return '该资源正在审核中, 暂时无法删除'
    return null
  }
}

export const GATE_KEYS = Object.keys(EXPECTED_GATE) as GateKey[]

export interface GateCase {
  key: GateKey
  kind: GateKind
  action: GateAction
  row: GateRow | null
  viewer: GateViewer
  pendingTask: boolean
  expected: string | null
}

const label = (c: Omit<GateCase, 'expected'>) =>
  `${c.key} status=${c.row?.status ?? 'none'} ${c.viewer.name}${c.pendingTask ? ' +task' : ''}`

export const gateCaseName = label

// 行恒属于 GATE_OWNER_UID; null 表示行不存在。在途任务只有编辑入口会查, 其余入口两种取值的期望相同
export const enumerateGateCases = (keys: readonly GateKey[] = GATE_KEYS) =>
  keys.flatMap((key) => {
    const [kind, action] = key.split('.') as [GateKind, GateAction]
    const rows: (GateRow | null)[] = [
      null,
      ...GATE_CODES[kind].map((status) => ({
        status,
        user_id: GATE_OWNER_UID
      }))
    ]
    return rows.flatMap((row) =>
      GATE_VIEWERS.flatMap((viewer) =>
        [false, true].map((pendingTask): GateCase => ({
          key,
          kind,
          action,
          row,
          viewer,
          pendingTask,
          expected: EXPECTED_GATE[key](row, viewer, pendingTask)
        }))
      )
    )
  })

// 编辑 / 删除入口把行锁下被跳过的行映射成文案 (HEAD 上各入口 ctx.fail 那几行的转录)。
// reason 与 status 的含义同 server/content/guard.ts 的 SkippedContent
export type GateSkip =
  | { reason: 'gone' }
  | { reason: 'owner' }
  | { reason: 'status'; status: number }

export const EXPECTED_SKIP_MESSAGE: Record<string, (s: GateSkip) => string> = {
  'comment.edit': (s) =>
    s.reason === 'owner'
      ? '您没有权限更改该评论'
      : s.reason === 'status' && s.status === 1
        ? '您发布的评论正在审核中, 暂时无法修改'
        : '未找到该评论',
  'comment.delete': (s) =>
    s.reason === 'owner'
      ? '您没有权限删除该评论'
      : s.reason === 'status' && s.status === 1
        ? '该评论正在审核中, 暂时无法删除'
        : '未找到对应的评论',
  'rating.edit': (s) =>
    s.reason === 'owner'
      ? '您没有权限更新该评价'
      : s.reason === 'status' && s.status === 1
        ? '您发布的评价正在审核中, 暂时无法修改'
        : '评价不存在',
  'rating.delete': (s) =>
    s.reason === 'owner'
      ? '您没有权限删除该评价'
      : s.reason === 'status' && s.status === 1
        ? '该评价正在审核中, 暂时无法删除'
        : '评价不存在',
  'resource.delete': (s) =>
    s.reason === 'owner'
      ? '您没有权限删除该资源'
      : s.reason === 'status' && s.status !== 1
        ? '该资源正在审核中, 暂时无法删除'
        : '未找到对应的资源'
}

// 编辑 / 删除入口交给命令的守卫 (HEAD 上各入口手写的那两行)
export interface GateGuard {
  statusIn: readonly number[]
  ownerUid?: number
}

export const EXPECTED_GUARD: Record<string, (v: GateViewer) => GateGuard> = {
  'comment.edit': (v) =>
    moderates(v) ? { statusIn: [0, 1] } : { statusIn: [0], ownerUid: v.uid },
  'comment.delete': (v) =>
    moderates(v) ? { statusIn: [0, 1] } : { statusIn: [0], ownerUid: v.uid },
  'rating.edit': (v) =>
    moderates(v) ? { statusIn: [0, 1] } : { statusIn: [0], ownerUid: v.uid },
  'rating.delete': (v) =>
    moderates(v) ? { statusIn: [0, 1] } : { statusIn: [0], ownerUid: v.uid },
  'resource.edit': (v) =>
    moderates(v) ? { statusIn: [0, 2, 3] } : { statusIn: [0], ownerUid: v.uid },
  'resource.delete': (v) =>
    moderates(v) ? { statusIn: [0, 2, 3] } : { statusIn: [0], ownerUid: v.uid }
}

// 守卫在锁下读到的行上的判定 (server/content/guard.ts 的 applyContentGuard 的转录: 先认行在不在,
// 再认作者, 最后认状态)。null 表示放行
export const expectedSkip = (
  locked: GateRow | null,
  guard: GateGuard
): GateSkip | null => {
  if (!locked) return { reason: 'gone' }
  if (guard.ownerUid !== undefined && locked.user_id !== guard.ownerUid)
    return { reason: 'owner' }
  if (!guard.statusIn.includes(locked.status))
    return { reason: 'status', status: locked.status }
  return null
}

// 锁下复检的组合: 预检时行是本人可动的公开行 (预检必然放行的那一类 viewer), 锁下读到的是
// locked (null 即已被删)。只取预检能放行的 viewer: 预检就拒的人走不到锁下
export const enumerateSkipCases = (key: GateKey) => {
  const [kind] = key.split('.') as [GateKind]
  const snapshot: GateRow = { status: 0, user_id: GATE_OWNER_UID }
  const lockedRows: (GateRow | null)[] = [
    null,
    ...GATE_CODES[kind].map((status) => ({
      status,
      user_id: GATE_OWNER_UID
    }))
  ]
  return GATE_VIEWERS.filter(
    (viewer) => EXPECTED_GATE[key](snapshot, viewer, false) === null
  ).flatMap((viewer) =>
    lockedRows.map((locked) => ({ key, kind, viewer, snapshot, locked }))
  )
}
