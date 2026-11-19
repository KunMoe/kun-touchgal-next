import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 删号的编排: 封禁先行 → 逐类调现成删除服务 → user 行锁下复核为 0 才删 user 行。各删除服务
// 自己的行为由它们的测试覆盖, 这里把它们换成对一份内存状态的增删, 只看编排; 外键与锁在真库上
// 的语义见 deleteAccount.db.test.ts

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)

const mocks = vi.hoisted(() => ({
  applyKunCredentialChange: vi.fn(),
  finishKunSecurityEvent: vi.fn(),
  deletePatchById: vi.fn(),
  deleteResource: vi.fn(),
  deleteComment: vi.fn(),
  deleteRating: vi.fn(),
  enqueueS3Deletion: vi.fn(),
  kickS3DeletionDrain: vi.fn(),
  invalidatePatchResourceDetailCache: vi.fn(),
  invalidateResourceStatsListCache: vi.fn(),
  invalidatePatchCommentCache: vi.fn(),
  invalidatePatchContentCacheByPatchId: vi.fn()
}))

vi.mock('~/prisma/index', () => rec.module)
vi.mock('~/server/auth/securityEvents', () => ({
  applyKunCredentialChange: mocks.applyKunCredentialChange,
  finishKunSecurityEvent: mocks.finishKunSecurityEvent
}))
vi.mock('~/app/api/patch/delete', () => ({
  deletePatchById: mocks.deletePatchById
}))
vi.mock('~/app/api/admin/resource/delete', () => ({
  deleteResource: mocks.deleteResource
}))
vi.mock('~/app/api/admin/comment/delete', () => ({
  deleteComment: mocks.deleteComment
}))
vi.mock('~/app/api/admin/rating/delete', () => ({
  deleteRating: mocks.deleteRating
}))
vi.mock('~/server/storage/s3Outbox', () => ({
  enqueueS3Deletion: mocks.enqueueS3Deletion,
  kickS3DeletionDrain: mocks.kickS3DeletionDrain
}))
vi.mock('~/app/api/patch/resource/cache', () => ({
  invalidatePatchResourceDetailCache: mocks.invalidatePatchResourceDetailCache
}))
vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceStatsListCache: mocks.invalidateResourceStatsListCache
}))
vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: mocks.invalidatePatchCommentCache
}))
vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCacheByPatchId:
    mocks.invalidatePatchContentCacheByPatchId
}))

import { deleteAccount } from '~/server/account/deleteAccount'
import { ACCOUNT_PURGERS, ACCOUNT_PURGE_ORDER } from '~/server/account/purgers'
import { USER_REFERENCES } from '~/server/account/userReferences'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { KUN_ROLE } from '~/constants/role'
import { Prisma } from '~/prisma/generated/prisma/client'

const TARGET = 7
const admin = kunTestActor({
  uid: 1,
  role: KUN_ROLE.SUPER_ADMIN,
  name: 'Admin'
})
const snapshot = {
  id: TARGET,
  name: 'target',
  email: 't@example.com',
  role: 1,
  status: 0
}

type Table = 'patch' | 'patch_resource' | 'patch_comment' | 'patch_rating'

// 库里指向被删用户的 purge 类行
let rows: Record<Table, number[]>
// 跨事务与服务调用的先后顺序
let events: string[]
// 每次收尾取 user 行锁时调用, 用来模拟「等锁期间在途请求刚提交了新内容」
let onUserLocked: () => void
let likedResourcePatches: number[]
let likedCommentPatches: number[]
let favoritePatches: number[]

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => from + index)

const remove = (table: Table, ids: number[]) => {
  rows[table] = rows[table].filter((id) => !ids.includes(id))
}

const configureReads = () => {
  rec.on('user.findUnique', snapshot)
  for (const table of [
    'patch',
    'patch_resource',
    'patch_comment',
    'patch_rating'
  ] as const) {
    rec.on(`${table}.count`, () => rows[table].length)
  }
  rec.on('patch.findMany', ({ take }: { take: number }) =>
    rows.patch.slice(0, take).map((id) => ({ id }))
  )
  // 清除器取批 (where.user_id) 与收尾收集点赞投影 (where.like_by) 共用这两个方法
  rec.on(
    'patch_resource.findMany',
    ({ where, take }: { where: { like_by?: unknown }; take: number }) =>
      where.like_by
        ? likedResourcePatches.map((patch_id) => ({ patch_id }))
        : rows.patch_resource.slice(0, take).map((id) => ({ id }))
  )
  rec.on(
    'patch_comment.findMany',
    ({ where, take }: { where: { like_by?: unknown }; take: number }) =>
      where.like_by
        ? likedCommentPatches.map((patch_id) => ({ patch_id }))
        : rows.patch_comment.slice(0, take).map((id) => ({ id }))
  )
  rec.on('patch_rating.findMany', ({ take }: { take: number }) =>
    rows.patch_rating.slice(0, take).map((id) => ({ id }))
  )
  rec.on('user_patch_favorite_folder_relation.findMany', () =>
    favoritePatches.map((patch_id) => ({ patch_id }))
  )
  rec.onRaw(/FROM "user" WHERE id = \? FOR UPDATE/, () => {
    events.push('finalize:lock')
    onUserLocked()
    return [{ id: TARGET }]
  })
}

const finalizeAttempts = () =>
  rec.attempts.filter((attempt) =>
    attempt.statements.some((s) => s.label.includes('FOR UPDATE'))
  )

const labelsOf = (attempt: (typeof rec.attempts)[number]) =>
  attempt.statements.map((s) => s.label)

beforeEach(() => {
  vi.resetAllMocks()
  rec.reset()
  rows = { patch: [], patch_resource: [], patch_comment: [], patch_rating: [] }
  events = []
  onUserLocked = () => {}
  likedResourcePatches = []
  likedCommentPatches = []
  favoritePatches = []
  configureReads()

  mocks.applyKunCredentialChange.mockImplementation(async () => {
    events.push('ban')
    return { count: 1, stamp: null }
  })
  mocks.finishKunSecurityEvent.mockImplementation(async (_uid, event) => {
    events.push(`session:${event}`)
    return { revokedOthers: 0 }
  })
  mocks.deletePatchById.mockImplementation(async ({ patchId }) => {
    events.push(`patch:${patchId}`)
    remove('patch', [patchId])
    return {}
  })
  mocks.deleteResource.mockImplementation(async ({ resourceIds }) => {
    events.push(`resource:${resourceIds.length}`)
    remove('patch_resource', resourceIds)
    return { count: resourceIds.length }
  })
  mocks.deleteComment.mockImplementation(async ({ commentIds }) => {
    events.push(`comment:${commentIds.length}`)
    remove('patch_comment', commentIds)
    return { deletedIds: commentIds }
  })
  mocks.deleteRating.mockImplementation(async ({ ratingIds }) => {
    events.push(`rating:${ratingIds.length}`)
    remove('patch_rating', ratingIds)
    return {}
  })
  mocks.enqueueS3Deletion.mockImplementation(async () => {
    events.push('finalize:enqueueAvatar')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('deleteAccount', () => {
  it('找不到用户、删除自己: 什么都不做', async () => {
    rec.on('user.findUnique', null)
    expect(await deleteAccount(TARGET, admin)).toBe('未找到用户')

    rec.on('user.findUnique', { ...snapshot, id: admin.uid })
    expect(await deleteAccount(admin.uid, admin)).toBe('请勿删除自己')

    expect(rec.attempts).toHaveLength(0)
    expect(mocks.applyKunCredentialChange).not.toHaveBeenCalled()
  })

  it('封禁先行: status=2 与开始日志同一事务, 删光会话之后才清第一批', async () => {
    rows.patch = [11]
    rows.patch_comment = [21]

    expect(await deleteAccount(TARGET, admin)).toEqual({ done: true })

    expect(mocks.applyKunCredentialChange).toHaveBeenCalledWith(
      expect.anything(),
      { uid: TARGET, event: 'account-deletion-started', data: { status: 2 } }
    )
    const [ban] = rec.attempts
    expect(labelsOf(ban)).toEqual(['admin_log.create'])
    expect(ban.statements[0].args).toMatchObject({
      data: { type: 'delete', user_id: admin.uid }
    })
    expect(
      (ban.statements[0].args as { data: { content: string } }).data.content
    ).toContain(JSON.stringify(snapshot))
    expect(events.slice(0, 3)).toEqual([
      'ban',
      'session:account-deletion-started',
      'patch:11'
    ])
  })

  it('封禁没写成 (用户刚被别人删掉): 不清除', async () => {
    rows.patch = [11]
    mocks.applyKunCredentialChange.mockResolvedValue({ count: 0, stamp: null })

    expect(await deleteAccount(TARGET, admin)).toBe('未找到用户')
    expect(mocks.finishKunSecurityEvent).not.toHaveBeenCalled()
    expect(mocks.deletePatchById).not.toHaveBeenCalled()
  })

  it('删会话失败: 照常往外抛, 不开始清除', async () => {
    rows.patch = [11]
    mocks.finishKunSecurityEvent.mockRejectedValue(new Error('redis down'))

    await expect(deleteAccount(TARGET, admin)).rejects.toThrow('redis down')
    expect(mocks.deletePatchById).not.toHaveBeenCalled()
  })

  it('按 游戏 → 资源 → 评论 → 评价 的顺序清除, 游戏每批 10 个、其余每批 100 条', async () => {
    rows.patch = range(1, 25)
    rows.patch_resource = range(1000, 250)
    rows.patch_comment = range(2000, 150)
    rows.patch_rating = range(3000, 5)

    expect(await deleteAccount(TARGET, admin)).toEqual({ done: true })

    expect(mocks.deletePatchById).toHaveBeenCalledTimes(25)
    expect(
      rec.outside
        .filter((statement) => statement.label === 'patch.findMany')
        .map((statement) => (statement.args as { take: number }).take)
    ).toEqual([10, 10, 10, 10])
    expect(
      mocks.deleteResource.mock.calls.map(([input]) => input.resourceIds)
    ).toEqual([range(1000, 100), range(1100, 100), range(1200, 50)])
    expect(
      mocks.deleteComment.mock.calls.map(([input]) => input.commentIds.length)
    ).toEqual([100, 50])
    expect(mocks.deleteRating.mock.calls).toEqual([
      [{ ratingIds: range(3000, 5) }, admin.uid]
    ])
    // 后台删除服务以操作者身份写各自的审计日志
    expect(mocks.deleteResource.mock.calls[0][1]).toBe(admin.uid)
    const steps = events.filter((e) =>
      /^(patch|resource|comment|rating):/.test(e)
    )
    expect(steps.findIndex((e) => e.startsWith('resource:'))).toBe(25)
    expect(steps.at(-1)).toBe('rating:5')
    expect(events.indexOf('finalize:lock')).toBeGreaterThan(
      events.indexOf('rating:5')
    )
  })

  it('清除期间冒出新行 (在途请求刚提交): 继续取下一批, 不当作没有进展', async () => {
    rows.patch_resource = [1, 2]
    mocks.deleteResource.mockImplementationOnce(async ({ resourceIds }) => {
      remove('patch_resource', resourceIds)
      rows.patch_resource.push(99)
      return { count: resourceIds.length }
    })

    expect(await deleteAccount(TARGET, admin)).toEqual({ done: true })
    expect(
      mocks.deleteResource.mock.calls.map(([input]) => input.resourceIds)
    ).toEqual([[1, 2], [99]])
  })

  it('服务返回字符串 (这批已被并发删掉): 重查而不报错', async () => {
    rows.patch_comment = [5, 6]
    mocks.deleteComment.mockImplementationOnce(async ({ commentIds }) => {
      remove('patch_comment', commentIds)
      return '未找到对应的评论'
    })

    expect(await deleteAccount(TARGET, admin)).toEqual({ done: true })
    expect(mocks.deleteComment).toHaveBeenCalledTimes(1)
  })

  it('连着两批 id 完全相同 (服务没删也没报错): 抛错, 不删 user 行', async () => {
    rows.patch_rating = [8, 9]
    mocks.deleteRating.mockResolvedValue({})

    await expect(deleteAccount(TARGET, admin)).rejects.toThrow(
      'patch_rating.user_id 的清除没有进展: 8, 9'
    )
    expect(mocks.deleteRating).toHaveBeenCalledTimes(2)
    expect(finalizeAttempts()).toHaveLength(0)
  })

  it('超出预算: 返回 done:false 与各类剩余数, 不进收尾; 账号已封禁', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    rows.patch = range(1, 30)
    rows.patch_resource = [100]
    mocks.deletePatchById.mockImplementation(async ({ patchId }) => {
      remove('patch', [patchId])
      now += 1_000
      return {}
    })

    const result = await deleteAccount(TARGET, admin, { budgetMs: 15_000 })

    // 删游戏在批内也看预算: 第二批删到第 15 个 (累计 15 秒) 就停, 不把一整批删完
    expect(result).toEqual({
      done: false,
      remaining: { 'patch.user_id': 15, 'patch_resource.user_id': 1 }
    })
    expect(mocks.deletePatchById).toHaveBeenCalledTimes(15)
    expect(mocks.deleteResource).not.toHaveBeenCalled()
    expect(finalizeAttempts()).toHaveLength(0)
    expect(mocks.applyKunCredentialChange).toHaveBeenCalledTimes(1)
  })

  it('预算为 0: 只封禁, 一批都不清, 回各类剩余数', async () => {
    rows.patch = [1, 2, 3]

    const result = await deleteAccount(TARGET, admin, { budgetMs: 0 })

    expect(mocks.deletePatchById).toHaveBeenCalledTimes(0)
    expect(result).toEqual({
      done: false,
      remaining: { 'patch.user_id': 3 }
    })
  })

  it('取批之后才越过截止时刻: 这一批仍删掉第一个游戏再停, 不把没清完的游戏当作清完', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    rows.patch = [1, 2, 3]
    rec.on('patch.findMany', ({ take }: { take: number }) => {
      now += 30_000
      return rows.patch.slice(0, take).map((id) => ({ id }))
    })

    const result = await deleteAccount(TARGET, admin, { budgetMs: 15_000 })

    expect(mocks.deletePatchById.mock.calls).toEqual([[{ patchId: 1 }]])
    expect(result).toEqual({
      done: false,
      remaining: { 'patch.user_id': 2 }
    })
  })

  it('游戏已被并发的删号请求删掉 (deletePatchById 抛 P2025): 当作已删除, 继续', async () => {
    rows.patch = [1, 2]
    mocks.deletePatchById.mockImplementationOnce(async ({ patchId }) => {
      remove('patch', [patchId])
      throw new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: 'test'
      })
    })

    expect(await deleteAccount(TARGET, admin)).toEqual({ done: true })
    expect(mocks.deletePatchById).toHaveBeenCalledTimes(2)
  })

  it('删游戏抛出别的错误: 照常往外抛', async () => {
    rows.patch = [1]
    mocks.deletePatchById.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('timeout', {
        code: 'P2028',
        clientVersion: 'test'
      })
    )

    await expect(deleteAccount(TARGET, admin)).rejects.toThrow('timeout')
    expect(finalizeAttempts()).toHaveLength(0)
  })

  it('收尾在锁下发现残余: 零写入, 回到清除再收尾', async () => {
    let locks = 0
    onUserLocked = () => {
      locks++
      if (locks === 1) {
        rows.patch_comment.push(77)
      }
    }

    expect(await deleteAccount(TARGET, admin)).toEqual({ done: true })

    const [first, second] = finalizeAttempts()
    expect(first.committed).toBe(true)
    expect(labelsOf(first)).toEqual([
      expect.stringContaining('FOR UPDATE'),
      'patch.count',
      'patch_resource.count',
      'patch_comment.count',
      'patch_rating.count'
    ])
    expect(mocks.deleteComment).toHaveBeenCalledWith(
      { commentIds: [77] },
      admin.uid
    )
    expect(labelsOf(second)).toContain('user.delete')
    expect(events.filter((e) => e === 'finalize:enqueueAvatar')).toHaveLength(1)
  })

  it('锁下每次都有残余: 来回三轮之后返回 done:false, 始终没删 user 行', async () => {
    let next = 500
    onUserLocked = () => {
      rows.patch_rating.push(next++)
    }

    const result = await deleteAccount(TARGET, admin)

    expect(result).toEqual({
      done: false,
      remaining: { 'patch_rating.user_id': 1 }
    })
    expect(finalizeAttempts()).toHaveLength(3)
    expect(
      rec.attempts.flatMap(labelsOf).filter((label) => label === 'user.delete')
    ).toHaveLength(0)
    expect(mocks.enqueueS3Deletion).not.toHaveBeenCalled()
  })

  it('收尾: 头像两个正式 key 入删除出箱后删 user 行并记日志, 提交后失效级联投影', async () => {
    likedResourcePatches = [3, 4]
    likedCommentPatches = [4]
    favoritePatches = [5]

    expect(await deleteAccount(TARGET, admin)).toEqual({ done: true })

    expect(mocks.enqueueS3Deletion).toHaveBeenCalledWith(expect.anything(), [
      `user/avatar/user_${TARGET}/avatar.avif`,
      `user/avatar/user_${TARGET}/avatar-mini.avif`
    ])
    const [finalize] = finalizeAttempts()
    const labels = labelsOf(finalize)
    expect(labels.indexOf('user.delete')).toBeGreaterThan(
      labels.indexOf('user_patch_favorite_folder_relation.findMany')
    )
    expect(labels.slice(-2)).toEqual(['user.delete', 'admin_log.create'])
    expect(rec.argsOf('user.delete')).toEqual([{ where: { id: TARGET } }])
    expect(rec.argsOf('admin_log.create')[0]).toMatchObject({
      data: { type: 'delete', user_id: admin.uid }
    })
    // 投影只算公开的资源 / 评论
    expect(
      rec
        .argsOf('patch_resource.findMany')
        .map((args) => (args as { where: object }).where)
    ).toEqual([{ like_by: { some: { user_id: TARGET } }, status: 0 }])

    expect(
      mocks.invalidatePatchResourceDetailCache.mock.calls.map(([id]) => id)
    ).toEqual([3, 4])
    expect(mocks.invalidateResourceStatsListCache).toHaveBeenCalledTimes(1)
    expect(mocks.invalidatePatchCommentCache.mock.calls).toEqual([[4]])
    expect(mocks.invalidatePatchContentCacheByPatchId).toHaveBeenCalledWith([5])
    expect(mocks.kickS3DeletionDrain).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toBe('session:account-deleted')
  })

  it('没有受影响的投影: 不失效', async () => {
    expect(await deleteAccount(TARGET, admin)).toEqual({ done: true })

    expect(mocks.invalidatePatchResourceDetailCache).not.toHaveBeenCalled()
    expect(mocks.invalidateResourceStatsListCache).not.toHaveBeenCalled()
    expect(mocks.invalidatePatchCommentCache).not.toHaveBeenCalled()
    expect(mocks.invalidatePatchContentCacheByPatchId).not.toHaveBeenCalled()
  })

  it('收尾时 user 行已不在 (被并发删掉): 回未找到用户, 不写任何东西', async () => {
    rec.onRaw(/FROM "user" WHERE id = \? FOR UPDATE/, [])

    expect(await deleteAccount(TARGET, admin)).toBe('未找到用户')
    const [finalize] = finalizeAttempts()
    expect(finalize.rolledBack).toBe(true)
    expect(labelsOf(finalize)).toHaveLength(1)
  })

  it('收尾事务默认隔离级别、超时放宽到 60 秒, 死锁回滚时重放', async () => {
    let locks = 0
    onUserLocked = () => {
      locks++
      if (locks === 1) {
        throw Object.assign(new Error('deadlock detected'), { code: 'P2034' })
      }
    }

    expect(await deleteAccount(TARGET, admin)).toEqual({ done: true })

    const [deadlocked, replayed] = finalizeAttempts()
    expect(deadlocked.rolledBack).toBe(true)
    expect(replayed.committed).toBe(true)
    expect(replayed.options).toEqual({ timeout: 60_000 })
    expect(labelsOf(replayed)).toContain('user.delete')
  })

  it('两个模块都不出现 isolationLevel', () => {
    for (const file of ['../deleteAccount.ts', '../purgers.ts']) {
      const source = readFileSync(
        fileURLToPath(new URL(file, import.meta.url)),
        'utf8'
      )
      expect(source).not.toContain('isolationLevel')
    }
  })
})

describe('ACCOUNT_PURGERS', () => {
  it('清除顺序恰好覆盖语义表里全部 purge 类引用', () => {
    const purged = Object.entries(USER_REFERENCES)
      .filter(([, action]) => action === 'purge')
      .map(([ref]) => ref)
      .sort()
    expect([...ACCOUNT_PURGE_ORDER].sort()).toEqual(purged)
    expect(Object.keys(ACCOUNT_PURGERS).sort()).toEqual(purged)
  })
})
