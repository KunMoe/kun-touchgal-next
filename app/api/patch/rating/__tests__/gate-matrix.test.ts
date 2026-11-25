import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXPECTED_GUARD,
  EXPECTED_SKIP_MESSAGE,
  GATE_OWNER_UID,
  enumerateGateCases,
  enumerateSkipCases,
  expectedSkip,
  gateCaseName
} from '~/utils/content/__tests__/gateCases'
import type { GateRow, GateViewer } from '~/utils/content/__tests__/gateCases'

// 评价的 4 个闸门 (点赞 / 举报 / 编辑 / 删除) 逐格对照期望表 (gateCases.ts), 驱动真实入口

const PASSED = '__passed_snapshot_gate__'

const {
  findUniqueMock,
  findUniqueOrThrowMock,
  reportFindFirstMock,
  hasPendingModerationMock,
  planTextModerationMock,
  editRatingMock,
  planRemovalMock,
  executeRemovalMock,
  verifyHeaderCookieMock,
  parseBodyMock,
  txMode
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  findUniqueOrThrowMock: vi.fn(),
  reportFindFirstMock: vi.fn(),
  hasPendingModerationMock: vi.fn(),
  planTextModerationMock: vi.fn(),
  editRatingMock: vi.fn(),
  planRemovalMock: vi.fn(),
  executeRemovalMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  parseBodyMock: vi.fn(),
  txMode: { snapshot: true }
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_rating: { findUnique: findUniqueMock },
    patch_report: { findFirst: reportFindFirstMock },
    $transaction: (callback: (tx: object) => unknown) =>
      callback({ patch_rating: { findUniqueOrThrow: findUniqueOrThrowMock } })
  }
}))

vi.mock('~/server/db/tx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/db/tx')>()
  return {
    ...actual,
    kunTx: ((...args: Parameters<typeof actual.kunTx>) =>
      txMode.snapshot
        ? Promise.resolve(PASSED)
        : actual.kunTx(...args)) as typeof actual.kunTx
  }
})

vi.mock('~/server/moderation/submit', () => ({
  hasPendingModeration: hasPendingModerationMock,
  planTextModeration: planTextModerationMock
}))

vi.mock('~/server/content/rating/edit', () => ({
  editRating: editRatingMock
}))

vi.mock('~/server/content/rating/remove', () => ({
  planRatingRemoval: planRemovalMock,
  executeRatingRemoval: executeRemovalMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePostBody: parseBodyMock,
  kunParsePutBody: parseBodyMock
}))

vi.mock('~/server/abuse/budget', () => ({
  kunAbuseGate: vi.fn(async () => null)
}))

import { applyContentGuard } from '~/server/content/guard'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { PUT as likeRating } from '~/app/api/patch/rating/like/route'
import { POST as reportRating } from '~/app/api/patch/rating/report/route'
import { updatePatchRating } from '~/app/api/patch/rating/update'
import { deletePatchRating } from '~/app/api/patch/rating/delete'

const RATING_ID = 5
const PATCH_ID = 3
const request = new Request('http://localhost') as never

const actorOf = (v: GateViewer) => kunTestActor({ uid: v.uid, role: v.role })

const ratingRow = (row: GateRow | null) =>
  row && {
    id: RATING_ID,
    patch_id: PATCH_ID,
    short_summary: '短评',
    ...row,
    patch: { id: PATCH_ID, name: '游戏', unique_id: 'kun123' }
  }

const UPDATE_INPUT = {
  ratingId: RATING_ID,
  recommend: 'yes',
  overall: 8,
  playStatus: 'finished',
  shortSummary: '改后',
  spoilerLevel: 'none'
} as never

const runGate = async (
  action: string,
  row: GateRow | null,
  viewer: GateViewer
) => {
  findUniqueMock.mockResolvedValue(ratingRow(row))
  verifyHeaderCookieMock.mockResolvedValue({
    uid: viewer.uid,
    role: viewer.role,
    name: viewer.name
  })
  switch (action) {
    case 'like':
      parseBodyMock.mockResolvedValue({ ratingId: RATING_ID })
      return (await likeRating(request)).json()
    case 'report':
      parseBodyMock.mockResolvedValue({
        ratingId: RATING_ID,
        patchId: PATCH_ID,
        content: '举报理由'
      })
      return (await reportRating(request)).json()
    case 'edit':
      return updatePatchRating(UPDATE_INPUT, actorOf(viewer))
    default:
      return deletePatchRating({ ratingId: RATING_ID }, actorOf(viewer))
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  txMode.snapshot = true
  reportFindFirstMock.mockResolvedValue({ id: 1 })
  // 编辑在预检之后先跑送审预筛: 让它直接返回哨兵
  planTextModerationMock.mockResolvedValue(PASSED)
})

const REPORT_PASSED = '您已经举报过该评价，请等待管理员处理'

describe('评价闸门的预检逐格对照期望表', () => {
  const cases = enumerateGateCases([
    'rating.like',
    'rating.report',
    'rating.edit',
    'rating.delete'
  ])

  it('覆盖全部组合', () => {
    expect(cases).toHaveLength(4 * 4 * 6 * 2)
  })

  it.each(cases.map((c) => [gateCaseName(c), c] as const))(
    '%s',
    async (_name, c) => {
      hasPendingModerationMock.mockResolvedValue(c.pendingTask)
      const result = await runGate(c.action, c.row, c.viewer)
      const passed = c.action === 'report' ? REPORT_PASSED : PASSED
      expect(result).toBe(c.expected ?? passed)
    }
  )
})

describe('评价编辑 / 删除的锁下复检逐格对照期望表', () => {
  for (const key of ['rating.edit', 'rating.delete'] as const) {
    const cases = enumerateSkipCases(key)

    it.each(
      cases.map(
        (c) =>
          [
            `${key} ${c.viewer.name} locked=${c.locked?.status ?? 'gone'}`,
            c
          ] as const
      )
    )('%s', async (_name, c) => {
      txMode.snapshot = false
      hasPendingModerationMock.mockResolvedValue(false)
      planTextModerationMock.mockResolvedValue({
        queue: false,
        intercept: false,
        dryRun: false
      })
      findUniqueOrThrowMock.mockResolvedValue({
        id: RATING_ID,
        patch: { unique_id: 'kun123' },
        like: [],
        _count: { like: 0 },
        user: { id: GATE_OWNER_UID, name: 'owner', avatar: '' }
      })
      const lockedRows = c.locked ? [{ id: RATING_ID, ...c.locked }] : []
      const guards: unknown[] = []
      editRatingMock.mockImplementation(
        async (_ctx, id: number, options: { guard: never }) => {
          guards.push(options.guard)
          const {
            passed: [row],
            skipped: [skipped]
          } = applyContentGuard([id], lockedRows, options.guard)
          return row ? { row, skipped: undefined } : { row: undefined, skipped }
        }
      )
      planRemovalMock.mockImplementation(
        async (_ctx, ids: number[], guard: never) => {
          guards.push(guard)
          return applyContentGuard(ids, lockedRows, guard)
        }
      )
      executeRemovalMock.mockResolvedValue(undefined)

      const result = await runGate(
        key === 'rating.edit' ? 'edit' : 'delete',
        c.snapshot,
        c.viewer
      )

      const guard = EXPECTED_GUARD[key](c.viewer)
      expect(guards).toEqual([guard])
      const skip = expectedSkip(c.locked, guard)
      if (skip) {
        expect(result).toBe(EXPECTED_SKIP_MESSAGE[key](skip))
      } else {
        expect(typeof result).toBe('object')
      }
    })
  }
})
