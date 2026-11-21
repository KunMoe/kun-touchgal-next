import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expectFlatConditionalUpdate,
  expectSameClientTransaction
} from '~/prisma/__tests__/support/sqlShape'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { KUN_ROLE } from '~/constants/role'
import type { RecordedStatement } from '~/prisma/__tests__/support/sqlRecorder'

// 群发任务依赖的编译器输出, 不连库。认领、推进、暂停、取消后的补记、收尾、取消与继续都把
// 条件 updateMany 的 count 当 CAS 用: 守卫必须平铺在 UPDATE 自己的 WHERE 里, 并发的另一方
// 提交之后库才会在这一行上重新求值它们 (取消检测、重叠防护都靠这一点)。库拿到这些 SQL 之后
// 在并发下的行为由 campaign.db.test.ts 在真库上守护

const { recorder, sendKunEmailMock } = await vi.hoisted(async () => ({
  recorder: (
    await import('~/prisma/__tests__/support/sqlRecorder')
  ).createSqlRecorder(),
  sendKunEmailMock: vi.fn()
}))

vi.mock('~/prisma/index', () => recorder.module)

vi.mock('~/app/api/utils/sendKunEmail', () => ({
  sendKunEmail: sendKunEmailMock
}))

vi.mock('~/constants/admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/constants/admin')>()),
  MAIL_CAMPAIGN_MIN_BATCH_INTERVAL_MS: 0
}))

import {
  createCampaign,
  runCampaignStep,
  transitionCampaign
} from '~/server/mail/campaign'

const actor = kunTestActor({ uid: 1, role: KUN_ROLE.SUPER_ADMIN })
const now = new Date('2026-11-22T00:00:00.000Z')
const campaignRow = {
  id: 7,
  template_id: 'touchgal',
  title: '标题',
  content_html: '<p>正文</p>',
  status: 'sending',
  site_origin: 'https://www.example.com',
  max_user_id: 100000,
  cursor_user_id: 40,
  total: 60,
  sent: 40,
  failed: 0,
  last_error: '',
  created_by: 1,
  created: now,
  updated: now,
  finished: null
}

// 取整行的是 runCampaignStep 开头找发送中的任务; 收尾时事务里那次只取三列
const SENDING_CAMPAIGN = /"content_html".* FROM "public"\."mail_campaign"/
const FINISHED_COUNTS =
  /^SELECT (?!.*"content_html").* FROM "public"\."mail_campaign"/
const RECIPIENTS = /"public"\."user"\."email" FROM "public"\."user"/
const UPDATE_CAMPAIGN = /^UPDATE "public"\."mail_campaign"/
const INSERT_LOG = /^INSERT INTO "public"\."admin_log"/

// 从 from 起连续 count 个收件人: 一整批是 100 个
const recipients = (from: number, count: number) => ({
  rows: Array.from({ length: count }, (_, index) => ({
    id: from + index,
    email: `user${from + index}@example.com`
  }))
})

const campaignUpdates = (statements: RecordedStatement[]) =>
  statements.filter(({ sql }) => UPDATE_CAMPAIGN.test(sql))

// 这条 UPDATE 是平铺 WHERE 的条件更新, 三个守卫 (任务、状态、游标) 都在
const expectHeld = (
  update: RecordedStatement,
  expected: { status: string; cursor: number }
) => {
  expectFlatConditionalUpdate([update], {
    table: 'mail_campaign',
    guards: ['id', 'status', 'cursor_user_id']
  })
  expect(guardValue(update, 'id')).toBe(7)
  expect(guardValue(update, 'status')).toBe(expected.status)
  expect(guardValue(update, 'cursor_user_id')).toBe(expected.cursor)
}

// 守卫列在 WHERE 里绑定的参数值
const guardValue = ({ sql, values }: RecordedStatement, column: string) => {
  const where = sql.slice(sql.indexOf(' WHERE '))
  const match = new RegExp(`"mail_campaign"\\."${column}" = \\$(\\d+)`).exec(
    where
  )
  return match ? values[Number(match[1]) - 1] : undefined
}

// SET 子句里被赋值的列
const assignedColumns = ({ sql }: RecordedStatement) =>
  [...sql.slice(0, sql.indexOf(' WHERE ')).matchAll(/"(\w+)" = /g)].map(
    ([, column]) => column
  )

const verbs = (statements: RecordedStatement[]) =>
  statements.map(({ sql }) => sql.split(' ')[0])

beforeEach(() => {
  recorder.reset()
  sendKunEmailMock.mockReset()
  sendKunEmailMock.mockResolvedValue(undefined)
  vi.stubEnv('KUN_EMAIL_UNSUBSCRIBE_SECRET', 'k'.repeat(32))
  vi.stubEnv('NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD', 'https://www.example.com')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runCampaignStep 发出的 SQL', () => {
  it('只找本站发起的发送中任务', async () => {
    await expect(
      runCampaignStep({ signal: new AbortController().signal })
    ).resolves.toEqual({ kind: 'idle' })

    const [find] = recorder.take()
    expect(find.sql).toMatch(
      /WHERE \("public"\."mail_campaign"\."status" = \$1 AND "public"\."mail_campaign"\."site_origin" = \$2\)/
    )
    expect(find.values.slice(0, 2)).toEqual([
      'sending',
      'https://www.example.com'
    ])
  })

  it('发信之前的认领与发完之后的推进都是条件更新: 任务 id、发送中、发这一批之前的游标平铺在各自的 WHERE 里', async () => {
    recorder.reply(SENDING_CAMPAIGN, { rows: [campaignRow] })
    recorder.reply(RECIPIENTS, recipients(41, 100))
    const controller = new AbortController()
    sendKunEmailMock.mockImplementationOnce(async () => {
      controller.abort()
    })

    await expect(
      runCampaignStep({ signal: controller.signal })
    ).resolves.toEqual({
      kind: 'progress',
      campaignId: 7,
      sent: 100,
      failed: 0
    })

    const [claim, advance, ...rest] = campaignUpdates(recorder.take())
    expect(rest).toHaveLength(0)
    expectHeld(claim, { status: 'sending', cursor: 40 })
    // 认领只刷新 updated, 不动游标与计数
    expect(assignedColumns(claim)).toEqual(['updated'])
    expectHeld(advance, { status: 'sending', cursor: 40 })
    expect(assignedColumns(advance)).toEqual(
      expect.arrayContaining(['cursor_user_id', 'sent', 'failed'])
    )
  })

  it('库报告认领影响 0 行时到此为止: 这一批不发', async () => {
    recorder.reply(SENDING_CAMPAIGN, { rows: [campaignRow] })
    recorder.reply(RECIPIENTS, recipients(41, 100))
    recorder.reply(UPDATE_CAMPAIGN, { rowCount: 0 })

    await expect(
      runCampaignStep({ signal: new AbortController().signal })
    ).resolves.toEqual({ kind: 'stopped', campaignId: 7, sent: 0, failed: 0 })

    expect(sendKunEmailMock).not.toHaveBeenCalled()
    expect(campaignUpdates(recorder.take())).toHaveLength(1)
  })

  it('自动暂停是一条同样守卫的条件更新, 只写状态与原因, 不动游标与计数', async () => {
    recorder.reply(SENDING_CAMPAIGN, { rows: [campaignRow] })
    recorder.reply(RECIPIENTS, recipients(41, 100))
    sendKunEmailMock.mockResolvedValue('邮件发送失败, 请稍后重试')

    await expect(
      runCampaignStep({ signal: new AbortController().signal })
    ).resolves.toMatchObject({ kind: 'paused', sent: 0, failed: 0 })

    const [, pause, ...rest] = campaignUpdates(recorder.take())
    expect(rest).toHaveLength(0)
    expectHeld(pause, { status: 'sending', cursor: 40 })
    expect(assignedColumns(pause).sort()).toEqual([
      'last_error',
      'status',
      'updated'
    ])
    expect(pause.values).toContain('paused')
  })

  it('库报告推进影响 0 行: 不再取下一批, 只在任务已取消且游标没被动过时把这一批补记上去', async () => {
    recorder.reply(SENDING_CAMPAIGN, { rows: [campaignRow] })
    recorder.reply(RECIPIENTS, recipients(41, 100), recipients(141, 100))
    // 认领命中, 推进落空, 补记也落空 (游标被别的进程推进过)
    recorder.reply(
      UPDATE_CAMPAIGN,
      { rowCount: 1 },
      { rowCount: 0 },
      { rowCount: 0 }
    )

    await expect(
      runCampaignStep({ signal: new AbortController().signal })
    ).resolves.toEqual({ kind: 'stopped', campaignId: 7, sent: 0, failed: 0 })

    const statements = recorder.take()
    expect(statements.filter(({ sql }) => RECIPIENTS.test(sql))).toHaveLength(1)
    const [, , record, ...rest] = campaignUpdates(statements)
    expect(rest).toHaveLength(0)
    expectHeld(record, { status: 'cancelled', cursor: 40 })
    expect(verbs(statements).at(-1)).toBe('UPDATE')
  })

  it('补记命中时, 这一批算进这一拍的结果', async () => {
    recorder.reply(SENDING_CAMPAIGN, { rows: [campaignRow] })
    recorder.reply(RECIPIENTS, recipients(41, 100))
    recorder.reply(
      UPDATE_CAMPAIGN,
      { rowCount: 1 },
      { rowCount: 0 },
      { rowCount: 1 }
    )

    await expect(
      runCampaignStep({ signal: new AbortController().signal })
    ).resolves.toEqual({
      kind: 'stopped',
      campaignId: 7,
      sent: 100,
      failed: 0
    })
  })

  it('收尾的条件更新与完成日志在同一个事务里, 守卫同样平铺', async () => {
    recorder.reply(SENDING_CAMPAIGN, {
      rows: [{ ...campaignRow, cursor_user_id: 100000 }]
    })
    recorder.reply(FINISHED_COUNTS, {
      rows: [{ sent: 60, failed: 0, created_by: 1 }]
    })

    await expect(
      runCampaignStep({ signal: new AbortController().signal })
    ).resolves.toEqual({ kind: 'done', campaignId: 7, sent: 0, failed: 0 })

    const statements = recorder.take()
    expectSameClientTransaction(statements, [UPDATE_CAMPAIGN, INSERT_LOG])
    const [finish, ...rest] = campaignUpdates(statements)
    expect(rest).toHaveLength(0)
    expectHeld(finish, { status: 'sending', cursor: 100000 })
    expect(finish.values).toContain('done')
  })

  it('库报告收尾影响 0 行时回滚, 不写完成日志', async () => {
    recorder.reply(SENDING_CAMPAIGN, {
      rows: [{ ...campaignRow, cursor_user_id: 100000 }]
    })
    recorder.reply(UPDATE_CAMPAIGN, { rowCount: 0 })

    await expect(
      runCampaignStep({ signal: new AbortController().signal })
    ).resolves.toEqual({ kind: 'stopped', campaignId: 7, sent: 0, failed: 0 })

    const sent = verbs(recorder.take())
    expect(sent).toContain('ROLLBACK')
    expect(sent).not.toContain('INSERT')
    expect(sent).not.toContain('COMMIT')
  })
})

describe('createCampaign 发出的 SQL', () => {
  const input = {
    templateId: 'touchgal' as const,
    title: '标题',
    contentHtml: '<p>正文</p>'
  }
  const ACTIVE_CHECK =
    /FROM "public"\."mail_campaign" WHERE "public"\."mail_campaign"\."status" IN/
  const COUNT_RECIPIENTS = /^SELECT COUNT\(\*\)/

  it('通告锁是事务里的第一条语句, 与随后的查、插在同一条连接上; 数人数不在这个事务里', async () => {
    recorder.reply(/ORDER BY "public"\."user"\."id" DESC/, {
      rows: [{ id: 500 }]
    })
    recorder.reply(COUNT_RECIPIENTS, { rows: [{ _count$_all: 321n }] })
    recorder.reply(/^INSERT INTO "public"\."mail_campaign"/, {
      rows: [{ id: 9 }]
    })

    await expect(createCampaign(input, actor)).resolves.toEqual({
      campaignId: 9
    })

    const statements = recorder.take()
    const body = expectSameClientTransaction(statements, [
      /^SELECT pg_advisory_xact_lock\(\$1::int, 0\)$/,
      ACTIVE_CHECK,
      /^INSERT INTO "public"\."mail_campaign"/,
      INSERT_LOG
    ])
    expect(body[0].sql).toMatch(/^SELECT pg_advisory_xact_lock/)
    expect(body[0].values).toEqual([481005])
    expect(body.some(({ sql }) => COUNT_RECIPIENTS.test(sql))).toBe(false)
    expect(
      statements.find(({ sql }) => COUNT_RECIPIENTS.test(sql))
    ).toMatchObject({ inTransaction: false })
  })

  it('已有进行中的任务时回滚, 不插入', async () => {
    recorder.reply(COUNT_RECIPIENTS, { rows: [{ _count$_all: 0n }] })
    recorder.reply(ACTIVE_CHECK, { rows: [{ id: 5 }] })

    await expect(createCampaign(input, actor)).resolves.toBe(
      '群发任务 #5 还没有结束, 等它发完或取消之后才能再发起'
    )

    const sent = verbs(recorder.take())
    expect(sent).toContain('ROLLBACK')
    expect(sent).not.toContain('INSERT')
  })
})

describe('transitionCampaign 发出的 SQL', () => {
  it('取消是条件更新: 只命中还没结束的任务, 与日志在同一个事务里', async () => {
    await expect(transitionCampaign(7, 'cancel', actor)).resolves.toEqual({})

    const statements = recorder.take()
    expectSameClientTransaction(statements, [UPDATE_CAMPAIGN, INSERT_LOG])
    const cancel = expectFlatConditionalUpdate(statements, {
      table: 'mail_campaign',
      guards: ['id']
    })
    // 状态守卫是 IN 列表, 同样是 UPDATE 自己的 WHERE 里的一个合取条件
    expect(cancel.sql.replace(/\s+/g, ' ')).toMatch(
      / AND "public"\."mail_campaign"\."status" IN \(\$\d+,\$\d+\)\)$/
    )
    expect(cancel.values).toEqual(
      expect.arrayContaining(['cancelled', 7, 'sending', 'paused'])
    )
  })

  it('继续发送是条件更新: 只命中暂停中的任务', async () => {
    await expect(transitionCampaign(7, 'resume', actor)).resolves.toEqual({})

    const resume = expectFlatConditionalUpdate(recorder.take(), {
      table: 'mail_campaign',
      guards: ['id', 'status']
    })
    expect(guardValue(resume, 'id')).toBe(7)
    expect(guardValue(resume, 'status')).toBe('paused')
  })

  it('库报告影响 0 行时回滚, 不记日志', async () => {
    recorder.reply(UPDATE_CAMPAIGN, { rowCount: 0 })

    await expect(transitionCampaign(7, 'cancel', actor)).resolves.toBe(
      '这个群发任务已经结束了'
    )

    const sent = verbs(recorder.take())
    expect(sent).toContain('ROLLBACK')
    expect(sent).not.toContain('INSERT')
  })
})
