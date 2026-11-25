import { describe, expect, it } from 'vitest'
import {
  contentGuard,
  contentSkipMessage,
  decideContentAction,
  isContentVisible,
  visiblePhases
} from '~/utils/content/policy'
import { applyContentGuard } from '~/server/content/guard'
import { can } from '~/constants/permission'
import { contentPhase } from '~/constants/contentStatus'
import {
  EXPECTED_GUARD,
  EXPECTED_SKIP_MESSAGE,
  GATE_CODES,
  GATE_OWNER_UID,
  GATE_VIEWERS,
  enumerateGateCases,
  gateCaseName
} from './gateCases'
import type { GateKey, GateKind, GateSkip, GateViewer } from './gateCases'

// 测试按 "kind.action" 字符串驱动; 动作是否属于该 kind 由夹具保证, 这里不再让类型系统检查
const decide = (
  key: GateKey,
  row: { status: number; user_id: number } | null,
  viewer: GateViewer | null,
  options?: { pendingTask?: boolean }
) => {
  const [kind, action] = key.split('.') as [GateKind, never]
  return decideContentAction(kind, row, viewer, action, options)
}

describe('decideContentAction 逐格对照入口原有的预检', () => {
  const cases = enumerateGateCases()

  it('覆盖 12 个闸门的全部组合', () => {
    expect(cases).toHaveLength(612)
  })

  it.each(cases.map((c) => [gateCaseName(c), c] as const))('%s', (_name, c) => {
    const decision = decide(c.key, c.row, c.viewer, {
      pendingTask: c.pendingTask
    })
    expect(decision.ok ? null : decision.message).toBe(c.expected)
  })
})

const EDIT_DELETE_KEYS = [
  'comment.edit',
  'comment.delete',
  'rating.edit',
  'rating.delete',
  'resource.edit',
  'resource.delete'
] as const

describe('contentGuard 等于入口原来手写的守卫', () => {
  it.each(
    EDIT_DELETE_KEYS.flatMap((key) =>
      GATE_VIEWERS.map((viewer) => [`${key} ${viewer.name}`, key, viewer])
    )
  )('%s', (_name, key, viewer) => {
    const [kind] = (key as string).split('.') as [GateKind]
    expect(contentGuard(kind, viewer as never)).toEqual(
      EXPECTED_GUARD[key as string](viewer as never)
    )
  })
})

// 守卫在锁下放行一行, 当且仅当预检在同一行上放行 (在途任务另算: 它不是行上的状态)
describe('守卫与预检等价', () => {
  const rows = (kind: GateKind) =>
    GATE_CODES[kind].flatMap((status) =>
      [GATE_OWNER_UID, 99].map((user_id) => ({ id: 1, status, user_id }))
    )

  it.each(
    EDIT_DELETE_KEYS.flatMap((key) =>
      GATE_VIEWERS.flatMap((viewer) => {
        const [kind] = key.split('.') as [GateKind]
        return rows(kind).map((row) => [
          `${key} ${viewer.name} status=${row.status} owner=${row.user_id}`,
          key,
          viewer,
          row
        ])
      })
    )
  )('%s', (_name, key, viewer, row) => {
    const [kind] = (key as string).split('.') as [GateKind]
    const guard = contentGuard(kind, viewer as never)
    const accepted =
      applyContentGuard([1], [row as never], guard).passed.length === 1
    expect(accepted).toBe(
      decide(key as GateKey, row as never, viewer as never).ok
    )
  })
})

describe('contentSkipMessage 逐格对照入口原来的锁下文案', () => {
  const skips = (kind: GateKind): GateSkip[] => [
    { reason: 'gone' },
    { reason: 'owner' },
    // 守卫的 statusIn 总含公开: 公开的行不会因为状态被跳过, 不在可达集合里
    ...GATE_CODES[kind]
      .filter((status) => status !== 0)
      .map((status) => ({ reason: 'status' as const, status }))
  ]
  // 资源编辑的锁下文案原在 update.ts 的 resourceEditGuardError 里, 与它的预检同一套
  const RESOURCE_EDIT_SKIP = (s: GateSkip) =>
    s.reason === 'owner'
      ? '您没有权限更改该资源'
      : s.reason === 'status' && s.status === 2
        ? '您发布的资源正在等待管理员审核, 暂时无法修改'
        : s.reason === 'status' && s.status === 3
          ? '您发布的资源正在审核中, 暂时无法修改'
          : '未找到该资源'

  it.each(
    EDIT_DELETE_KEYS.flatMap((key) => {
      const [kind] = key.split('.') as [GateKind]
      return skips(kind).map((skip) => [
        `${key} ${skip.reason}${skip.reason === 'status' ? `=${skip.status}` : ''}`,
        key,
        skip
      ])
    })
  )('%s', (_name, key, skip) => {
    const [kind, action] = (key as string).split('.') as [GateKind, never]
    const expected =
      key === 'resource.edit'
        ? RESOURCE_EDIT_SKIP(skip as GateSkip)
        : EXPECTED_SKIP_MESSAGE[key as string](skip as GateSkip)
    expect(
      contentSkipMessage(kind, action, {
        id: 1,
        ...(skip as GateSkip)
      } as never)
    ).toBe(expected)
  })
})

describe('可见性', () => {
  const VIEWERS = [null, ...GATE_VIEWERS]

  it.each(
    (['comment', 'rating', 'resource'] as const).flatMap((kind) =>
      GATE_CODES[kind].flatMap((status) =>
        VIEWERS.map((viewer) => [
          `${kind} status=${status} ${viewer?.name ?? 'anonymous'}`,
          kind,
          status,
          viewer
        ])
      )
    )
  )('%s', (_name, kind, status, viewer) => {
    const phase = contentPhase(kind as GateKind, status as number)
    const v = viewer as (typeof VIEWERS)[number]
    const expected =
      phase === 'public' ||
      (phase !== 'hidden' &&
        (can(v, 'content.viewPending') || v?.uid === GATE_OWNER_UID))
    expect(
      isContentVisible(
        kind as GateKind,
        { status: status as number, user_id: GATE_OWNER_UID },
        v
      )
    ).toBe(expected)
  })

  it('隐藏对任何人都不在可见阶段里', () => {
    for (const viewer of VIEWERS) {
      expect(visiblePhases(viewer, true)).not.toContain('hidden')
    }
  })
})

describe('认不出的编码按隐藏处理', () => {
  it.each(['comment', 'rating', 'resource'] as const)('%s', (kind) => {
    expect(contentPhase(kind, 9)).toBe('hidden')
    const owner = GATE_VIEWERS[0]
    for (const action of ['like', 'edit', 'delete'] as const) {
      const decision = decideContentAction(
        kind,
        { status: 9, user_id: 1 },
        owner,
        action
      )
      expect(decision.ok).toBe(false)
    }
  })
})
