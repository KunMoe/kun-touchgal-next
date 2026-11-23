import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectFlatConditionalUpdate } from '~/prisma/__tests__/support/sqlShape'

// 写出箱 drain 依赖的编译器输出, 不连库。成功删行与被拒记账都按 (patch_id, seq) 当 CAS 用:
// 两个条件必须平铺在 DELETE / UPDATE 自己的 WHERE 里, 处理期间有新的入队 (seq 已换发) 时
// 库在这一行上重新求值才会不命中, 新内容不会被当成已同步删掉、也不会替旧内容背失败次数。
// 库拿到这些 SQL 之后的行为由 sync.db.test.ts 在真库上守护

const { recorder, meili } = await vi.hoisted(async () => ({
  recorder: (
    await import('~/prisma/__tests__/support/sqlRecorder')
  ).createSqlRecorder(),
  meili: { task: { status: 'succeeded' } as object }
}))

vi.mock('~/prisma/index', () => recorder.module)

// 夹具的 patch 不存在 (findUnique 默认读回空), drain 走删除分支
vi.mock('~/lib/meilisearch', () => ({
  getMeiliClient: () => ({
    index: () => ({
      deleteDocument: () => ({ waitTask: async () => meili.task })
    })
  })
}))

vi.mock('~/server/tasks/withTaskLock', () => ({
  withTaskLock: (
    _options: unknown,
    task: (renew: () => Promise<void>) => Promise<unknown>
  ) => task(async () => {})
}))

import { drainSearchOutbox } from '~/server/search/sync'

const CLAIM = /^SELECT .* FROM "public"\."search_outbox"/
const DELETE_OUTBOX = /^DELETE FROM "public"\."search_outbox"/

const claimOne = () =>
  recorder.reply(CLAIM, {
    rows: [{ patch_id: 5, seq: 41, attempts: 2 }]
  })

beforeEach(() => {
  recorder.reset()
  meili.task = { status: 'succeeded' }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('drainSearchOutbox 发出的 SQL', () => {
  it('同步成功后的删行是一条 DELETE, (patch_id, seq) 平铺在它自己的 WHERE 里', async () => {
    claimOne()

    await drainSearchOutbox()

    const deletes = recorder
      .take()
      .filter(({ sql }) => DELETE_OUTBOX.test(sql.replace(/\s+/g, ' ')))
    expect(deletes).toHaveLength(1)
    const where = deletes[0].sql
      .replace(/\s+/g, ' ')
      .split(' WHERE ')
      .slice(1)
      .join(' WHERE ')
    expect(where).not.toMatch(/\b(SELECT|EXISTS|JOIN|WITH|FROM)\b/i)
    expect(where).toMatch(/"search_outbox"\."patch_id" = \$\d+/)
    expect(where).toMatch(/"search_outbox"\."seq" = \$\d+/)
    expect(deletes[0].values).toEqual(expect.arrayContaining([5, 41]))
  })

  it('被拒时的记账是一条平铺 WHERE 的条件 UPDATE, 不删行', async () => {
    claimOne()
    meili.task = {
      status: 'failed',
      error: { code: 'invalid_document_id', type: 'invalid_request' }
    }

    await drainSearchOutbox()

    const statements = recorder.take()
    const update = expectFlatConditionalUpdate(statements, {
      table: 'search_outbox',
      guards: ['patch_id', 'seq']
    })
    expect(update.values).toEqual(expect.arrayContaining([5, 41, 3]))
    expect(
      statements.some(({ sql }) => DELETE_OUTBOX.test(sql.replace(/\s+/g, ' ')))
    ).toBe(false)
  })

  it('引擎整体收不了写入时把这一行挪开, 同样是平铺 WHERE 的条件 UPDATE', async () => {
    claimOne()
    meili.task = {
      status: 'failed',
      error: { code: 'internal', type: 'internal' }
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await drainSearchOutbox()

    const update = expectFlatConditionalUpdate(recorder.take(), {
      table: 'search_outbox',
      guards: ['patch_id', 'seq']
    })
    expect(update.sql).not.toMatch(/"attempts"/)
    expect(update.values).toEqual(expect.arrayContaining([5, 41]))
  })
})
