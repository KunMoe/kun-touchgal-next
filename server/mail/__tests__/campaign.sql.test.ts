import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expectFlatConditionalUpdate,
  expectSameClientTransaction
} from '~/prisma/__tests__/support/sqlShape'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { KUN_ROLE } from '~/constants/role'
import type { RecordedStatement } from '~/prisma/__tests__/support/sqlRecorder'

// 群发任务依赖的编译器输出, 不连库。推进游标、收尾、取消与继续都把条件 updateMany 的
// count 当 CAS 用: 守卫必须平铺在 UPDATE 自己的 WHERE 里, 并发的另一方提交之后库才会在
// 这一行上重新求值它们 (取消检测、重叠防护都靠这一点)。库拿到这些 SQL 之后在并发下的
// 行为由 campaign.db.test.ts 在真库上守护

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
  max_user_id: 100,
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

const recipients = (...ids: number[]) => ({
  rows: ids.map((id) => ({ id, email: `user${id}@example.com` }))
})

// 守卫列在 WHERE 里绑定的参数值
const guardValue = ({ sql, values }: RecordedStatement, column: string) => {
  const where = sql.slice(sql.indexOf(' WHERE '))
  const match = new RegExp(`"mail_campaign"\\."${column}" = \\$(\\d+)`).exec(
    where
  )
  return match ? values[Number(match[1]) - 1] : undefined
}

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
  it('推进游标是一条条件更新: 任务 id、发送中、发这一批之前的游标都平铺在它自己的 WHERE 里', async () => {
    recorder.reply(SENDING_CAMPAIGN, { rows: [campaignRow] })
    recorder.reply(RECIPIENTS, recipients(41, 45))
    const controller = new AbortController()
    sendKunEmailMock.mockImplementationOnce(async () => {
      controller.abort()
    })

    await expect(
      runCampaignStep({ signal: controller.signal })
    ).resolves.toEqual({ kind: 'progress', campaignId: 7, sent: 2, failed: 0 })

    const advance = expectFlatConditionalUpdate(recorder.take(), {
      table: 'mail_campaign',
      guards: ['id', 'status', 'cursor_user_id']
    })
    expect(guardValue(advance, 'id')).toBe(7)
    expect(guardValue(advance, 'status')).toBe('sending')
    expect(guardValue(advance, 'cursor_user_id')).toBe(40)
  })

  it('自动暂停写在同一条条件更新里, 不另发一条', async () => {
    recorder.reply(SENDING_CAMPAIGN, { rows: [campaignRow] })
    recorder.reply(RECIPIENTS, recipients(41, 45))
    sendKunEmailMock.mockResolvedValue('邮件发送失败, 请稍后重试')

    await expect(
      runCampaignStep({ signal: new AbortController().signal })
    ).resolves.toMatchObject({ kind: 'paused', failed: 2 })

    const pause = expectFlatConditionalUpdate(recorder.take(), {
      table: 'mail_campaign',
      guards: ['id', 'status', 'cursor_user_id']
    })
    expect(pause.values).toContain('paused')
    expect(guardValue(pause, 'status')).toBe('sending')
  })

  it('库报告推进影响 0 行时到此为止, 不再取下一批', async () => {
    recorder.reply(SENDING_CAMPAIGN, { rows: [campaignRow] })
    recorder.reply(RECIPIENTS, recipients(41, 45), recipients(46, 47))
    recorder.reply(UPDATE_CAMPAIGN, { rowCount: 0 })

    await expect(
      runCampaignStep({ signal: new AbortController().signal })
    ).resolves.toEqual({ kind: 'stopped', campaignId: 7, sent: 0, failed: 0 })

    const statements = recorder.take()
    expect(statements.filter(({ sql }) => RECIPIENTS.test(sql))).toHaveLength(1)
    expect(verbs(statements).at(-1)).toBe('UPDATE')
  })

  it('收尾的条件更新与完成日志在同一个事务里, 守卫同样平铺', async () => {
    recorder.reply(SENDING_CAMPAIGN, {
      rows: [{ ...campaignRow, cursor_user_id: 100 }]
    })
    recorder.reply(FINISHED_COUNTS, {
      rows: [{ sent: 60, failed: 0, created_by: 1 }]
    })

    await expect(
      runCampaignStep({ signal: new AbortController().signal })
    ).resolves.toEqual({ kind: 'done', campaignId: 7, sent: 0, failed: 0 })

    const statements = recorder.take()
    expectSameClientTransaction(statements, [UPDATE_CAMPAIGN, INSERT_LOG])
    const finish = expectFlatConditionalUpdate(statements, {
      table: 'mail_campaign',
      guards: ['id', 'status', 'cursor_user_id']
    })
    expect(guardValue(finish, 'status')).toBe('sending')
    expect(guardValue(finish, 'cursor_user_id')).toBe(100)
    expect(finish.values).toContain('done')
  })

  it('库报告收尾影响 0 行时回滚, 不写完成日志', async () => {
    recorder.reply(SENDING_CAMPAIGN, {
      rows: [{ ...campaignRow, cursor_user_id: 100 }]
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
  it('通告锁是事务里的第一条语句, 与随后的查、插在同一条连接上', async () => {
    recorder.reply(/ORDER BY "public"\."user"\."id" DESC/, {
      rows: [{ id: 500 }]
    })
    recorder.reply(/^SELECT COUNT\(\*\)/, { rows: [{ _count$_all: 321n }] })
    recorder.reply(/^INSERT INTO "public"\."mail_campaign"/, {
      rows: [{ id: 9 }]
    })

    await expect(
      createCampaign(
        { templateId: 'touchgal', title: '标题', contentHtml: '<p>正文</p>' },
        actor
      )
    ).resolves.toEqual({ campaignId: 9 })

    const body = expectSameClientTransaction(recorder.take(), [
      /^SELECT pg_advisory_xact_lock\(\$1::int, 0\)$/,
      /FROM "public"\."mail_campaign" WHERE "public"\."mail_campaign"\."status" IN/,
      /^INSERT INTO "public"\."mail_campaign"/,
      INSERT_LOG
    ])
    expect(body[0].sql).toMatch(/^SELECT pg_advisory_xact_lock/)
    expect(body[0].values).toEqual([481005])
  })

  it('已有进行中的任务时回滚, 不插入', async () => {
    recorder.reply(
      /FROM "public"\."mail_campaign" WHERE "public"\."mail_campaign"\."status" IN/,
      { rows: [{ id: 5 }] }
    )

    await expect(
      createCampaign(
        { templateId: 'touchgal', title: '标题', contentHtml: '<p>正文</p>' },
        actor
      )
    ).resolves.toBe('群发任务 #5 还没有结束, 等它发完或取消之后才能再发起')

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
