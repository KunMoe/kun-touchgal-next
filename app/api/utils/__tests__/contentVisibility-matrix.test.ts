import { describe, expect, it, vi } from 'vitest'

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  hasPendingResource: vi.fn()
}))

import { can } from '~/constants/permission'
import {
  getCommentRatingVisibilityWhere,
  getResourceVisibilityWhere
} from '~/app/api/utils/contentVisibility'
import { visibleSql } from '~/server/content/visibility'

// 三张内容表在前台的可见性逐格对照: 每个取值 × 作者与否 × 每类 viewer。WHERE 片段用一个只认
// 这几种形状的小求值器在行上求值, 比的是语义而不是写法; 写法另由 contentVisibility.test.ts 钉住。
// 期望是 T29 动手前 HEAD 的口径: 公开对所有人可见; 待审 (评论 / 评价的 1, 资源的 2 / 3) 只对
// 作者与有 content.viewPending 能力的角色可见; 隐藏 (评论 / 评价的 2, 资源的 1) 对前台所有人
// 都不可见, 管理员也不例外

type Where = Record<string, unknown>
type Row = { status: number; user_id: number }

const matches = (where: Where, row: Row): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key === 'OR') {
      return (value as Where[]).some((w) => matches(w, row))
    }
    if (key === 'AND') {
      return (value as Where[]).every((w) => matches(w, row))
    }
    const actual = row[key as keyof Row]
    if (typeof value === 'number') {
      return actual === value
    }
    const { in: list, ...rest } = value as { in?: number[] }
    expect(rest).toEqual({})
    return list!.includes(actual)
  })

const OWNER = 7
const VIEWERS = [
  { name: 'anonymous', viewer: null },
  { name: 'member', viewer: { uid: 8, role: 1 } },
  { name: 'owner-member', viewer: { uid: OWNER, role: 1 } },
  { name: 'owner-creator', viewer: { uid: OWNER, role: 2 } },
  { name: 'moderator', viewer: { uid: 8, role: 3 } },
  { name: 'superadmin', viewer: { uid: 9, role: 4 } }
] as const

const PENDING = { comment: [1], resource: [2, 3] } as const
const CODES = { comment: [0, 1, 2], resource: [0, 1, 2, 3] } as const

const expectedVisible = (
  kind: 'comment' | 'resource',
  status: number,
  viewer: (typeof VIEWERS)[number]['viewer']
) => {
  if (status === 0) return true
  if (!(PENDING[kind] as readonly number[]).includes(status)) return false
  return can(viewer, 'content.viewPending') || viewer?.uid === OWNER
}

const cases = (['comment', 'resource'] as const).flatMap((kind) =>
  CODES[kind].flatMap((status) =>
    VIEWERS.map(({ name, viewer }) => ({
      name: `${kind} status=${status} ${name}`,
      kind,
      status,
      viewer,
      expected: expectedVisible(kind, status, viewer)
    }))
  )
)

describe('内容可见性逐格对照', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const where =
      c.kind === 'comment'
        ? getCommentRatingVisibilityWhere(c.viewer)
        : getResourceVisibilityWhere(c.viewer)
    expect(matches(where, { status: c.status, user_id: OWNER })).toBe(
      c.expected
    )
  })
})

describe('评论可见性的 SQL 方言', () => {
  // 两种方言必须同口径: 原生 SQL 只有两种写法, 逐类 viewer 与表别名钉住文本与参数
  it.each(
    VIEWERS.flatMap(({ name, viewer }) =>
      (['patch_comment', 'pc'] as const).map(
        (alias) => [`${name} ${alias}`, viewer, alias] as const
      )
    )
  )('%s', (_name, viewer, alias) => {
    const sql = visibleSql('comment', viewer, alias)
    if (can(viewer, 'content.viewPending')) {
      expect(sql.sql).toBe(`${alias}.status IN (0, 1)`)
      expect(sql.values).toEqual([])
    } else {
      expect(sql.sql).toBe(
        `(${alias}.status = 0 OR (${alias}.status = 1 AND ${alias}.user_id = ?))`
      )
      expect(sql.values).toEqual([viewer?.uid ?? 0])
    }
  })
})
