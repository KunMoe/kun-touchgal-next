import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXPECTED_GUARD,
  EXPECTED_SKIP_MESSAGE,
  enumerateGateCases,
  enumerateSkipCases,
  expectedSkip,
  gateCaseName
} from '~/utils/content/__tests__/gateCases'
import type { GateRow, GateViewer } from '~/utils/content/__tests__/gateCases'

// 资源的 3 个闸门 (点赞 / 编辑 / 删除) 逐格对照期望表 (gateCases.ts), 驱动真实入口。
// 编辑的锁下复检另由 update-guard-recheck.test.ts 覆盖 (它在锁下还要重绑 S3 对象, 桩太多)

const PASSED = '__passed_snapshot_gate__'
// 编辑入口过了闸门之后的第一步是核对资源与 Galgame 是否匹配: 夹具故意不匹配, 用它当哨兵
const EDIT_PASSED = '资源与 Galgame 不匹配'

const {
  findUniqueMock,
  hasPendingModerationMock,
  planRemovalMock,
  executeRemovalMock,
  verifyHeaderCookieMock,
  parseBodyMock,
  txMode
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  hasPendingModerationMock: vi.fn(),
  planRemovalMock: vi.fn(),
  executeRemovalMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  parseBodyMock: vi.fn(),
  txMode: { snapshot: true }
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_resource: { findUnique: findUniqueMock },
    $transaction: (callback: (tx: object) => unknown) => callback({})
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
  planTextModeration: vi.fn(),
  enqueueTextModeration: vi.fn()
}))

vi.mock('~/server/content/resource/remove', () => ({
  lockResourceOwnerAccounts: vi.fn(),
  planResourceRemoval: planRemovalMock,
  executeResourceRemoval: executeRemovalMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePutBody: parseBodyMock
}))

import { applyContentGuard } from '~/server/content/guard'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { PUT as likeResource } from '~/app/api/patch/resource/like/route'
import { updatePatchResource } from '~/app/api/patch/resource/update'
import { deleteResource } from '~/app/api/patch/resource/delete'

const RESOURCE_ID = 5
const PATCH_ID = 3
const request = new Request('http://localhost') as never

const actorOf = (v: GateViewer) => kunTestActor({ uid: v.uid, role: v.role })

const resourceRow = (row: GateRow | null) =>
  row && {
    id: RESOURCE_ID,
    patch_id: PATCH_ID,
    name: '资源',
    section: 'galgame',
    links: [],
    ...row,
    patch: { name: '游戏', unique_id: 'kun123' }
  }

const UPDATE_INPUT = {
  resourceId: RESOURCE_ID,
  patchId: PATCH_ID + 1,
  section: 'galgame',
  links: [],
  emulatorType: [],
  modelName: '',
  platform: ['windows'],
  type: ['pc']
} as never

const runGate = async (
  action: string,
  row: GateRow | null,
  viewer: GateViewer
) => {
  findUniqueMock.mockResolvedValue(resourceRow(row))
  verifyHeaderCookieMock.mockResolvedValue({
    uid: viewer.uid,
    role: viewer.role,
    name: viewer.name
  })
  const actor = actorOf(viewer)
  switch (action) {
    case 'like':
      parseBodyMock.mockResolvedValue({ resourceId: RESOURCE_ID })
      return (await likeResource(request)).json()
    case 'edit':
      return updatePatchResource(UPDATE_INPUT, actor, 'front')
    default:
      return deleteResource({ resourceId: RESOURCE_ID }, actor)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  txMode.snapshot = true
})

describe('资源闸门的预检逐格对照期望表', () => {
  const cases = enumerateGateCases([
    'resource.like',
    'resource.edit',
    'resource.delete'
  ])

  it('覆盖全部组合', () => {
    expect(cases).toHaveLength(3 * 5 * 6 * 2)
  })

  it.each(cases.map((c) => [gateCaseName(c), c] as const))(
    '%s',
    async (_name, c) => {
      hasPendingModerationMock.mockResolvedValue(c.pendingTask)
      const result = await runGate(c.action, c.row, c.viewer)
      const passed = c.action === 'edit' ? EDIT_PASSED : PASSED
      expect(result).toBe(c.expected ?? passed)
    }
  )
})

describe('资源删除的锁下复检逐格对照期望表', () => {
  const cases = enumerateSkipCases('resource.delete')

  it.each(
    cases.map(
      (c) =>
        [`${c.viewer.name} locked=${c.locked?.status ?? 'gone'}`, c] as const
    )
  )('%s', async (_name, c) => {
    txMode.snapshot = false
    const lockedRows = c.locked ? [{ id: RESOURCE_ID, ...c.locked }] : []
    const guards: unknown[] = []
    planRemovalMock.mockImplementation(
      async (_ctx, ids: number[], options: { guard: never }) => {
        guards.push(options.guard)
        return applyContentGuard(ids, lockedRows, options.guard)
      }
    )
    executeRemovalMock.mockResolvedValue(undefined)

    const result = await runGate('delete', c.snapshot, c.viewer)

    const guard = EXPECTED_GUARD['resource.delete'](c.viewer)
    expect(guards).toEqual([guard])
    const skip = expectedSkip(c.locked, guard)
    if (skip) {
      expect(result).toBe(EXPECTED_SKIP_MESSAGE['resource.delete'](skip))
    } else {
      expect(result).toEqual({})
    }
  })
})
