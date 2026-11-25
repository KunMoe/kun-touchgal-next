import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXPECTED_GATE,
  EXPECTED_GUARD,
  EXPECTED_SKIP_MESSAGE,
  GATE_OWNER_UID,
  GATE_VIEWERS,
  enumerateGateCases,
  enumerateSkipCases,
  expectedSkip,
  gateCaseName
} from '~/utils/content/__tests__/gateCases'
import type { GateRow, GateViewer } from '~/utils/content/__tests__/gateCases'

// 评论的 5 个闸门 (点赞 / 举报 / 回复 / 编辑 / 删除) 逐格对照期望表 (gateCases.ts)。驱动的是真实
// 入口: 只把读库、送审、渲染这些依赖换成桩, 预检放行与否看入口有没有走到闸门之后的第一步

const PASSED = '__passed_snapshot_gate__'

const {
  findUniqueMock,
  findFirstMock,
  reportFindFirstMock,
  hasPendingModerationMock,
  planTextModerationMock,
  prepareMock,
  editCommentMock,
  planRemovalMock,
  executeRemovalMock,
  verifyHeaderCookieMock,
  parseBodyMock,
  txMode
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  findFirstMock: vi.fn(),
  reportFindFirstMock: vi.fn(),
  hasPendingModerationMock: vi.fn(),
  planTextModerationMock: vi.fn(),
  prepareMock: vi.fn(),
  editCommentMock: vi.fn(),
  planRemovalMock: vi.fn(),
  executeRemovalMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  parseBodyMock: vi.fn(),
  // snapshot: 进事务即视为过了预检; locked: 走真实 kunTx, 由命令桩给出锁下的判定
  txMode: { snapshot: true }
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: { findUnique: findUniqueMock, findFirst: findFirstMock },
    patch_report: { findFirst: reportFindFirstMock },
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
  planTextModeration: planTextModerationMock,
  enqueueTextModeration: vi.fn()
}))

vi.mock('~/app/api/patch/comment/html', () => ({
  prepareCommentContent: prepareMock
}))

vi.mock('~/server/content/comment/edit', () => ({
  editComment: editCommentMock
}))

vi.mock('~/server/content/comment/remove', () => ({
  planCommentRemoval: planRemovalMock,
  executeCommentRemoval: executeRemovalMock
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
import { can } from '~/constants/permission'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { PUT as likeComment } from '~/app/api/patch/comment/like/route'
import { POST as reportComment } from '~/app/api/patch/comment/report/route'
import { createPatchComment } from '~/app/api/patch/comment/create'
import { updateComment } from '~/app/api/patch/comment/update'
import { deleteComment } from '~/app/api/patch/comment/delete'

const COMMENT_ID = 5
const PATCH_ID = 3
const request = new Request('http://localhost') as never

const actorOf = (v: GateViewer) => kunTestActor({ uid: v.uid, role: v.role })

type ContainerRow = { status: number; user_id: number } | null

const commentRow = (row: GateRow | null, resource: ContainerRow = null) =>
  row && {
    id: COMMENT_ID,
    patch_id: PATCH_ID,
    resource_id: resource ? 11 : null,
    content: '正文',
    ...row,
    resource,
    patch: { unique_id: 'kun123' }
  }

const routeResult = async (response: Response) => response.json()

const runGate = async (
  action: string,
  row: GateRow | null,
  viewer: GateViewer,
  resource: ContainerRow = null
) => {
  findUniqueMock.mockResolvedValue(commentRow(row, resource))
  findFirstMock.mockResolvedValue(commentRow(row, resource))
  verifyHeaderCookieMock.mockResolvedValue({
    uid: viewer.uid,
    role: viewer.role,
    name: viewer.name
  })
  switch (action) {
    case 'like':
      parseBodyMock.mockResolvedValue({ commentId: COMMENT_ID })
      return routeResult(await likeComment(request))
    case 'report':
      parseBodyMock.mockResolvedValue({
        commentId: COMMENT_ID,
        patchId: PATCH_ID,
        content: '举报理由'
      })
      return routeResult(await reportComment(request))
    case 'reply':
      return createPatchComment(
        { patchId: PATCH_ID, parentId: COMMENT_ID, content: '回复' } as never,
        actorOf(viewer)
      )
    case 'edit':
      return updateComment(
        { commentId: COMMENT_ID, content: '改后', isSpoiler: false },
        actorOf(viewer)
      )
    default:
      return deleteComment({ commentId: COMMENT_ID }, actorOf(viewer))
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  txMode.snapshot = true
  // 举报走到「查重」即过了预检: 让它命中已有举报, 返回固定文案
  reportFindFirstMock.mockResolvedValue({ id: 1 })
  planTextModerationMock.mockResolvedValue({
    queue: false,
    intercept: false,
    dryRun: false
  })
  // 回复与编辑在预检之后先准备正文: 让它直接返回哨兵
  prepareMock.mockResolvedValue(PASSED)
})

const REPORT_PASSED = '您已经举报过该评论，请等待管理员处理'

describe('评论闸门的预检逐格对照期望表', () => {
  const cases = enumerateGateCases([
    'comment.like',
    'comment.report',
    'comment.reply',
    'comment.edit',
    'comment.delete'
  ])

  it('覆盖全部组合', () => {
    expect(cases).toHaveLength(5 * 4 * 6 * 2)
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

describe('评论编辑 / 删除的锁下复检逐格对照期望表', () => {
  for (const key of ['comment.edit', 'comment.delete'] as const) {
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
      prepareMock.mockResolvedValue({ content_html: '<p>改后</p>' })
      const lockedRows = c.locked ? [{ id: COMMENT_ID, ...c.locked }] : []
      const guards: unknown[] = []
      editCommentMock.mockImplementation(
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
          const { passed, skipped } = applyContentGuard(ids, lockedRows, guard)
          return { roots: passed, skipped, subtree: [] }
        }
      )
      executeRemovalMock.mockResolvedValue({ deletedIds: [COMMENT_ID] })

      const result = await runGate(
        key === 'comment.edit' ? 'edit' : 'delete',
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

// X02-04: 评论区随所属资源关闭。资源对 viewer 不可见时, 点赞、举报、编辑一律按评论不存在处理;
// 删除自己的评论不受影响 (回复由发评论的资源检查覆盖)。资源属于 uid 8 (other-member)
describe('评论区随所属资源关闭', () => {
  const RESOURCE_OWNER = 8
  const comment: GateRow = { status: 0, user_id: GATE_OWNER_UID }
  const resourceVisible = (status: number, viewer: GateViewer) =>
    status === 0 ||
    ((status === 2 || status === 3) &&
      (viewer.uid === RESOURCE_OWNER || can(viewer, 'content.viewPending')))

  const cases = (['like', 'report', 'edit', 'delete'] as const).flatMap(
    (action) =>
      [0, 1, 2, 3].flatMap((status) =>
        GATE_VIEWERS.map((viewer) => ({ action, status, viewer }))
      )
  )

  it.each(
    cases.map(
      (c) =>
        [
          `comment.${c.action} resource=${c.status} ${c.viewer.name}`,
          c
        ] as const
    )
  )('%s', async (_name, c) => {
    hasPendingModerationMock.mockResolvedValue(false)
    const key = `comment.${c.action}`
    const closed = c.action !== 'delete' && !resourceVisible(c.status, c.viewer)
    const expected = closed
      ? EXPECTED_GATE[key](null, c.viewer, false)
      : EXPECTED_GATE[key](comment, c.viewer, false)

    const result = await runGate(c.action, comment, c.viewer, {
      status: c.status,
      user_id: RESOURCE_OWNER
    })

    const passed = c.action === 'report' ? REPORT_PASSED : PASSED
    expect(result).toBe(expected ?? passed)
  })
})
