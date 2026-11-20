import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pgErrors } from '~/prisma/__tests__/support/pgErrorFixtures'
import {
  expectFlatConditionalUpdate,
  expectSameClientTransaction
} from '~/prisma/__tests__/support/sqlShape'

// 发起私聊依赖的编译器输出与错误映射, 不连库: 扣费的条件更新在事务里、没有行锁,
// 同目标并发时落败者是靠库重新求值这条 UPDATE 的 WHERE 被挡下的

const recorder = await vi.hoisted(async () =>
  (await import('~/prisma/__tests__/support/sqlRecorder')).createSqlRecorder()
)

vi.mock('~/prisma/index', () => recorder.module)

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
}))

import { getOrCreateConversation } from '~/app/api/message/conversation/service'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'

const actor = kunTestActor({ uid: 1, role: 1 })
const now = new Date('2026-11-20T00:00:00.000Z')
const conversationRow = {
  id: 99,
  user_a_id: 1,
  user_b_id: 2,
  last_message_id: null,
  last_message_time: now,
  user_a_unread_count: 0,
  user_b_unread_count: 0,
  created: now,
  updated: now
}

const FIND_CONVERSATION = /FROM "public"\."user_conversation" WHERE/

beforeEach(() => {
  recorder.reset()
  // 事务之前的两次读取: 发起人的余额、对方是否接受私信
  recorder.reply(/"moemoepoint" FROM "public"\."user"/, {
    rows: [{ id: 1, moemoepoint: 25 }]
  })
  recorder.reply(/"allow_private_message" FROM "public"\."user"/, {
    rows: [{ id: 2, allow_private_message: true }]
  })
})

describe('getOrCreateConversation 发出的 SQL', () => {
  it('扣费与建会话在同一条连接的同一个事务里, 扣费是平铺 WHERE 的条件更新', async () => {
    recorder.reply(/^INSERT INTO "public"\."user_conversation"/, {
      rows: [conversationRow]
    })

    await expect(
      getOrCreateConversation({ targetUserId: 2 }, actor)
    ).resolves.toEqual({ conversationId: 99, isNew: true })

    const statements = recorder.take()
    expectSameClientTransaction(statements, [
      /^UPDATE "public"\."user"/,
      /^INSERT INTO "public"\."user_conversation"/
    ])
    expectFlatConditionalUpdate(statements, {
      table: 'user',
      guards: ['id', 'moemoepoint']
    })
  })

  it('条件更新影响 0 行时回滚, 不建会话', async () => {
    recorder.reply(/^UPDATE "public"\."user"/, { rowCount: 0 })

    await expect(
      getOrCreateConversation({ targetUserId: 2 }, actor)
    ).resolves.toBe('萌萌点不足，发起私聊需要至少 20 萌萌点')

    const sent = recorder.take().map(({ sql }) => sql.split(' ')[0])
    expect(sent).toContain('ROLLBACK')
    expect(sent).not.toContain('INSERT')
    expect(sent).not.toContain('COMMIT')
  })

  it('建会话撞上唯一索引: 驱动的 23505 被认作对方已建好, 事务回滚后回读那一行', async () => {
    recorder.reply(/^INSERT INTO "public"\."user_conversation"/, {
      error: pgErrors.uniqueViolationComposite
    })
    // 第一次回读发生在事务之前 (还没有会话), 第二次在撞索引之后
    recorder.reply(FIND_CONVERSATION, { rows: [] }, { rows: [conversationRow] })

    await expect(
      getOrCreateConversation({ targetUserId: 2 }, actor)
    ).resolves.toEqual({ conversationId: 99, isNew: false })

    const sent = recorder.take().map(({ sql }) => sql.split(' ')[0])
    expect(sent).toContain('ROLLBACK')
    expect(sent).not.toContain('COMMIT')
  })
})
