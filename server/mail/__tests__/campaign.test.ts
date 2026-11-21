import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { KUN_ROLE } from '~/constants/role'

const { rec, sendKunEmailMock } = await vi.hoisted(async () => ({
  rec: (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction(),
  sendKunEmailMock: vi.fn()
}))

vi.mock('~/prisma/index', () => rec.module)

vi.mock('~/app/api/utils/sendKunEmail', () => ({
  sendKunEmail: sendKunEmailMock
}))

// 一批 3 封、批间不等待: 几个用户就能走出多批
vi.mock('~/constants/admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/constants/admin')>()),
  MAIL_CAMPAIGN_BATCH_SIZE: 3,
  MAIL_CAMPAIGN_MIN_BATCH_INTERVAL_MS: 0
}))

import {
  createCampaign,
  listCampaigns,
  runCampaignStep,
  transitionCampaign
} from '~/server/mail/campaign'
import { verifyUnsubscribeToken } from '~/server/mail/unsubscribeToken'

interface CampaignRow {
  id: number
  template_id: string
  title: string
  content_html: string
  status: string
  max_user_id: number
  cursor_user_id: number
  total: number
  sent: number
  failed: number
  last_error: string
  created_by: number | null
  created: Date
  finished: Date | null
}

interface UserRow {
  id: number
  email: string
  enable_email_notice: boolean
}

// 一张任务表加一张用户表的内存替身: 读与条件更新按传进来的 where 求值, 所以下面断言的是
// 「发给了谁、任务行最后是什么样」, 而不是某个方法被调用了几次
let campaigns: CampaignRow[]
let users: UserRow[]

const ADMIN = kunTestActor({ uid: 1, role: KUN_ROLE.SUPER_ADMIN, name: '鲲' })

type StatusFilter = string | { in: string[] } | undefined

const statusMatches = (row: CampaignRow, status: StatusFilter) =>
  status === undefined ||
  (typeof status === 'string'
    ? row.status === status
    : status.in.includes(row.status))

const campaignRow = (overrides: Partial<CampaignRow> = {}): CampaignRow => ({
  id: 7,
  template_id: 'touchgal',
  title: '停机维护通知',
  content_html: '<p>今晚维护</p>',
  status: 'sending',
  max_user_id: 100,
  cursor_user_id: 0,
  total: 0,
  sent: 0,
  failed: 0,
  last_error: '',
  created_by: 1,
  created: new Date('2026-11-22T00:00:00Z'),
  finished: null,
  ...overrides
})

const userRows = (ids: number[]): UserRow[] =>
  ids.map((id) => ({
    id,
    email: `user${id}@example.com`,
    enable_email_notice: true
  }))

const installFakeDatabase = () => {
  rec.on('mail_campaign.findFirst', ({ where }: any) => {
    const [row] = campaigns
      .filter((item) => statusMatches(item, where?.status))
      .sort((a, b) => a.id - b.id)
    return row ? { ...row } : null
  })
  rec.on('mail_campaign.findUniqueOrThrow', ({ where }: any) => ({
    ...campaigns.find((item) => item.id === where.id)
  }))
  rec.on('mail_campaign.findMany', ({ take }: any) =>
    [...campaigns]
      .sort((a, b) => b.id - a.id)
      .slice(0, take)
      .map((row) => ({
        ...row,
        creator: row.created_by
          ? { id: row.created_by, name: '鲲', avatar: '' }
          : null
      }))
  )
  rec.on('mail_campaign.updateMany', ({ where, data }: any) => {
    const row = campaigns.find(
      (item) =>
        item.id === where.id &&
        statusMatches(item, where.status) &&
        (where.cursor_user_id === undefined ||
          item.cursor_user_id === where.cursor_user_id)
    )
    if (!row) {
      return { count: 0 }
    }
    const target = row as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries<any>(data)) {
      target[key] =
        value && typeof value === 'object' && 'increment' in value
          ? (target[key] as number) + value.increment
          : value
    }
    return { count: 1 }
  })
  rec.on('mail_campaign.create', ({ data }: any) => {
    const row = campaignRow({
      id: Math.max(0, ...campaigns.map((item) => item.id)) + 1,
      ...data
    })
    campaigns.push(row)
    return { id: row.id }
  })
  rec.on('user.findMany', ({ where, take }: any) =>
    users
      .filter(
        (user) =>
          user.id > where.id.gt &&
          user.id <= where.id.lte &&
          user.enable_email_notice === where.enable_email_notice
      )
      .sort((a, b) => a.id - b.id)
      .slice(0, take)
      .map(({ id, email }) => ({ id, email }))
  )
  rec.on('user.findFirst', () => {
    const [newest] = [...users].sort((a, b) => b.id - a.id)
    return newest ? { id: newest.id } : null
  })
  rec.on(
    'user.count',
    ({ where }: any) =>
      users.filter(
        (user) =>
          user.id <= where.id.lte &&
          user.enable_email_notice === where.enable_email_notice
      ).length
  )
}

const neverAborted = () => new AbortController().signal

const mailedAddresses = () =>
  sendKunEmailMock.mock.calls.map(([payload]) => payload.to[0] as string)

const statementsNamed = (label: string) =>
  [...rec.outside, ...rec.attempts.flatMap((attempt) => attempt.statements)]
    .filter((statement) => statement.label === label)
    .map((statement) => statement.args as any)

const committedLogs = () =>
  rec.attempts
    .filter((attempt) => attempt.committed)
    .flatMap((attempt) => attempt.statements)
    .filter((statement) => statement.label === 'admin_log.create')
    .map((statement) => (statement.args as any).data)

beforeEach(() => {
  rec.reset()
  sendKunEmailMock.mockReset()
  sendKunEmailMock.mockResolvedValue(undefined)
  vi.stubEnv('KUN_EMAIL_UNSUBSCRIBE_SECRET', 'k'.repeat(32))
  vi.stubEnv('NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD', 'https://www.example.com')
  campaigns = []
  users = []
  installFakeDatabase()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runCampaignStep', () => {
  it('没有发送中的任务时什么都不做', async () => {
    campaigns = [
      campaignRow({ status: 'paused' }),
      campaignRow({ id: 8, status: 'done' })
    ]
    users = userRows([1, 2, 3])

    await expect(runCampaignStep({ signal: neverAborted() })).resolves.toEqual({
      kind: 'idle'
    })

    expect(statementsNamed('user.findMany')).toHaveLength(0)
    expect(sendKunEmailMock).not.toHaveBeenCalled()
  })

  it('按 id 顺序一批批发给范围内开着邮件通知的用户, 每人一封, 发完标成完成', async () => {
    campaigns = [campaignRow({ max_user_id: 8 })]
    users = userRows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    users[3].enable_email_notice = false

    await expect(runCampaignStep({ signal: neverAborted() })).resolves.toEqual({
      kind: 'done',
      campaignId: 7,
      sent: 7,
      failed: 0
    })

    // 4 号关了通知, 9、10 号是任务创建之后才注册的
    expect(mailedAddresses()).toEqual(
      [1, 2, 3, 5, 6, 7, 8].map((id) => `user${id}@example.com`)
    )
    expect(campaigns[0]).toMatchObject({
      status: 'done',
      cursor_user_id: 8,
      sent: 7,
      failed: 0,
      finished: expect.any(Date)
    })
    expect(committedLogs()).toEqual([
      {
        type: 'update',
        user_id: 1,
        content: '群发邮件任务 #7 已发送完毕 (成功 7 封, 失败 0 封)'
      }
    ])
  })

  it('每批都从上一批的末位 id 之后取, 走主键、带范围上界与通知开关', async () => {
    campaigns = [campaignRow({ max_user_id: 50 })]
    users = userRows([2, 4, 6, 8, 10])

    await runCampaignStep({ signal: neverAborted() })

    expect(statementsNamed('user.findMany')).toEqual(
      [0, 6, 10].map((cursor) => ({
        where: {
          id: { gt: cursor, lte: 50 },
          enable_email_notice: true
        },
        orderBy: { id: 'asc' },
        take: 3,
        select: { id: true, email: true }
      }))
    )
  })

  it('从任务行里的游标接着发, 之前发过的人不再收到', async () => {
    campaigns = [campaignRow({ cursor_user_id: 4, sent: 4 })]
    users = userRows([1, 2, 3, 4, 5, 6])

    await expect(runCampaignStep({ signal: neverAborted() })).resolves.toEqual({
      kind: 'done',
      campaignId: 7,
      sent: 2,
      failed: 0
    })

    expect(mailedAddresses()).toEqual([
      'user5@example.com',
      'user6@example.com'
    ])
    expect(campaigns[0]).toMatchObject({ cursor_user_id: 6, sent: 6 })
  })

  it('每封邮件用的是任务行里的模板、标题与正文, 退订链接是收件人自己的', async () => {
    campaigns = [campaignRow({ template_id: 'announcement' })]
    users = userRows([5, 6])

    await runCampaignStep({ signal: neverAborted() })

    const payloads = sendKunEmailMock.mock.calls.map(([payload]) => payload)
    expect(payloads).toHaveLength(2)
    for (const [index, uid] of [5, 6].entries()) {
      const payload = payloads[index]
      expect(payload.tag).toBe('announcement')
      expect(payload.html_body).toContain('停机维护通知')
      expect(payload.html_body).toContain('<p>今晚维护</p>')
      const href = /href="([^"]*email-notice[^"]*)"/.exec(payload.html_body)
      const link = new URL((href?.[1] ?? '').replaceAll('&amp;', '&'))
      expect(link.searchParams.get('u')).toBe(String(uid))
      expect(
        verifyUnsubscribeToken(uid, link.searchParams.get('t') ?? '')
      ).toBe(true)
    }
  })

  it('发送途中退订的用户, 轮到他那一批时不再发', async () => {
    campaigns = [campaignRow()]
    users = userRows([1, 2, 3, 4, 5])
    sendKunEmailMock.mockImplementationOnce(async () => {
      users[4].enable_email_notice = false
    })

    await runCampaignStep({ signal: neverAborted() })

    expect(mailedAddresses()).not.toContain('user5@example.com')
    expect(campaigns[0]).toMatchObject({ status: 'done', sent: 4 })
  })

  it('个别失败只记数, 任务继续', async () => {
    campaigns = [campaignRow()]
    users = userRows([1, 2, 3, 4, 5, 6])
    sendKunEmailMock.mockImplementation(async ({ to }) =>
      to[0] === 'user2@example.com' ? '邮件发送失败, 请稍后重试' : undefined
    )

    await expect(runCampaignStep({ signal: neverAborted() })).resolves.toEqual({
      kind: 'done',
      campaignId: 7,
      sent: 5,
      failed: 1
    })

    expect(campaigns[0]).toMatchObject({ status: 'done', sent: 5, failed: 1 })
  })

  it('一批里失败过半就自动暂停: 记下这一批、写明原因, 不再取下一批', async () => {
    campaigns = [campaignRow()]
    users = userRows([1, 2, 3, 4, 5, 6, 7, 8, 9])
    sendKunEmailMock.mockImplementation(async ({ to }) =>
      ['user4@example.com', 'user6@example.com'].includes(to[0])
        ? '邮件发送失败, 请稍后重试'
        : undefined
    )

    const result = await runCampaignStep({ signal: neverAborted() })

    expect(result).toMatchObject({
      kind: 'paused',
      campaignId: 7,
      sent: 4,
      failed: 2
    })
    expect(mailedAddresses()).toHaveLength(6)
    expect(campaigns[0]).toMatchObject({
      status: 'paused',
      cursor_user_id: 6,
      sent: 4,
      failed: 2,
      finished: null
    })
    expect(campaigns[0].last_error).toContain('一批 3 封里有 2 封发送失败')
    expect(campaigns[0].last_error).toContain('邮件发送失败, 请稍后重试')
    expect(committedLogs()).toEqual([])
  })

  it('发信函数抛出的异常同样算这一封失败, 不会让这一拍崩掉', async () => {
    campaigns = [campaignRow()]
    users = userRows([1, 2, 3])
    sendKunEmailMock.mockRejectedValue(new Error('socket hang up'))

    await expect(
      runCampaignStep({ signal: neverAborted() })
    ).resolves.toMatchObject({ kind: 'paused', sent: 0, failed: 3 })

    expect(campaigns[0].last_error).toContain('socket hang up')
  })

  it('任务行里的模板已不存在: 一封都不发, 任务暂停并说明原因', async () => {
    campaigns = [campaignRow({ template_id: 'retired-template' })]
    users = userRows([1, 2, 3, 4])

    await expect(
      runCampaignStep({ signal: neverAborted() })
    ).resolves.toMatchObject({ kind: 'paused', sent: 0, failed: 3 })

    expect(sendKunEmailMock).not.toHaveBeenCalled()
    expect(campaigns[0].last_error).toContain(
      '邮件模板 retired-template 不存在'
    )
  })

  it('暂停原因按列宽截断, 不会因为一条超长的错误写不进库', async () => {
    campaigns = [campaignRow()]
    users = userRows([1])
    sendKunEmailMock.mockRejectedValue(new Error('😀'.repeat(2000)))

    await runCampaignStep({ signal: neverAborted() })

    expect([...campaigns[0].last_error]).toHaveLength(1007)
    expect(campaigns[0].last_error.isWellFormed()).toBe(true)
  })

  it('发送途中任务被取消: 推进命中 0 行就停, 不取下一批, 也不改任务行', async () => {
    campaigns = [campaignRow()]
    users = userRows([1, 2, 3, 4, 5, 6])
    sendKunEmailMock.mockImplementationOnce(async () => {
      campaigns[0].status = 'cancelled'
    })

    await expect(runCampaignStep({ signal: neverAborted() })).resolves.toEqual({
      kind: 'stopped',
      campaignId: 7,
      sent: 0,
      failed: 0
    })

    expect(mailedAddresses()).toHaveLength(3)
    expect(statementsNamed('user.findMany')).toHaveLength(1)
    expect(campaigns[0]).toMatchObject({
      status: 'cancelled',
      cursor_user_id: 0,
      sent: 0
    })
  })

  it('游标被另一个进程推进过: 落后的一方命中 0 行就停, 最多多发这一批', async () => {
    campaigns = [campaignRow()]
    users = userRows([1, 2, 3, 4, 5, 6, 7, 8, 9])
    sendKunEmailMock.mockImplementationOnce(async () => {
      campaigns[0].cursor_user_id = 3
      campaigns[0].sent = 3
    })

    await expect(
      runCampaignStep({ signal: neverAborted() })
    ).resolves.toMatchObject({ kind: 'stopped', sent: 0 })

    expect(mailedAddresses()).toHaveLength(3)
    expect(campaigns[0]).toMatchObject({
      status: 'sending',
      cursor_user_id: 3,
      sent: 3
    })
  })

  it('收件范围已经发完、收尾时任务却被取消了: 不标完成, 也不记日志', async () => {
    campaigns = [campaignRow({ cursor_user_id: 3, sent: 3 })]
    users = userRows([1, 2, 3])
    rec.on('user.findMany', () => {
      campaigns[0].status = 'cancelled'
      return []
    })

    await expect(runCampaignStep({ signal: neverAborted() })).resolves.toEqual({
      kind: 'stopped',
      campaignId: 7,
      sent: 0,
      failed: 0
    })

    expect(campaigns[0]).toMatchObject({ status: 'cancelled', finished: null })
    expect(rec.attempts.at(-1)).toMatchObject({ rolledBack: true })
    expect(committedLogs()).toEqual([])
  })

  it('范围内没有可发的人时直接完成', async () => {
    campaigns = [campaignRow({ max_user_id: 0 })]
    users = userRows([1, 2])

    await expect(runCampaignStep({ signal: neverAborted() })).resolves.toEqual({
      kind: 'done',
      campaignId: 7,
      sent: 0,
      failed: 0
    })

    expect(sendKunEmailMock).not.toHaveBeenCalled()
    expect(campaigns[0].status).toBe('done')
  })

  it('发起的管理员已注销时, 完成日志不挂在任何人名下', async () => {
    campaigns = [campaignRow({ created_by: null, max_user_id: 0 })]

    await runCampaignStep({ signal: neverAborted() })

    expect(committedLogs()).toEqual([
      expect.objectContaining({ user_id: null })
    ])
  })

  it('signal 已经中止时不发任何一批', async () => {
    campaigns = [campaignRow()]
    users = userRows([1, 2, 3])
    const controller = new AbortController()
    controller.abort()

    await expect(
      runCampaignStep({ signal: controller.signal })
    ).resolves.toEqual({ kind: 'progress', campaignId: 7, sent: 0, failed: 0 })

    expect(sendKunEmailMock).not.toHaveBeenCalled()
    expect(campaigns[0]).toMatchObject({ status: 'sending', cursor_user_id: 0 })
  })

  it('signal 在一批发送途中中止: 这一批照常记进任务行, 然后停下等下一拍', async () => {
    campaigns = [campaignRow()]
    users = userRows([1, 2, 3, 4, 5, 6])
    const controller = new AbortController()
    sendKunEmailMock.mockImplementationOnce(async () => {
      controller.abort()
    })

    await expect(
      runCampaignStep({ signal: controller.signal })
    ).resolves.toEqual({ kind: 'progress', campaignId: 7, sent: 3, failed: 0 })

    expect(mailedAddresses()).toHaveLength(3)
    expect(campaigns[0]).toMatchObject({
      status: 'sending',
      cursor_user_id: 3,
      sent: 3
    })
  })

  it('有多个发送中的任务时先推进最早的那个', async () => {
    campaigns = [campaignRow({ id: 9 }), campaignRow({ id: 8 })]
    users = userRows([1])

    await expect(
      runCampaignStep({ signal: neverAborted() })
    ).resolves.toMatchObject({ kind: 'done', campaignId: 8 })
  })
})

describe('createCampaign', () => {
  const input = {
    templateId: 'touchgal' as const,
    title: '停机维护通知',
    contentHtml: '<p>今晚维护, 详情见 <a href="/doc">文档</a></p>'
  }

  it('先拿通告锁, 再查有没有进行中的任务', async () => {
    users = userRows([1, 2, 3])

    await createCampaign(input, ADMIN)

    const [lock, ...rest] = rec.labels()
    expect(lock).toBe('$executeRaw: SELECT pg_advisory_xact_lock(?::int, 0)')
    expect(rec.argsOf(lock)).toEqual([[481005]])
    expect(rest[0]).toBe('mail_campaign.findFirst')
    expect(statementsNamed('mail_campaign.findFirst')[0].where).toEqual({
      status: { in: ['sending', 'paused'] }
    })
  })

  it('把此刻的最大用户 id 定为收件范围, 估出人数, 建任务并记日志', async () => {
    users = userRows([1, 2, 3, 40])
    users[1].enable_email_notice = false

    await expect(createCampaign(input, ADMIN)).resolves.toEqual({
      campaignId: 1
    })

    expect(campaigns).toEqual([
      expect.objectContaining({
        id: 1,
        status: 'sending',
        template_id: 'touchgal',
        title: '停机维护通知',
        content_html: input.contentHtml,
        max_user_id: 40,
        cursor_user_id: 0,
        total: 3,
        created_by: 1
      })
    ])
    expect(rec.attempts).toHaveLength(1)
    // 建任务这一步不发信, 也不去取收件人
    expect(sendKunEmailMock).not.toHaveBeenCalled()
    expect(statementsNamed('user.findMany')).toHaveLength(0)
    expect(committedLogs()).toEqual([
      {
        type: 'create',
        user_id: 1,
        content:
          '管理员 鲲 发起了群发邮件任务 #1 (模板 touchgal, 预计 3 封)\n标题: 停机维护通知'
      }
    ])
  })

  it.each(['sending', 'paused'])(
    '已有%s的任务时拒绝, 事务回滚, 不建新任务',
    async (status) => {
      campaigns = [campaignRow({ id: 5, status })]
      users = userRows([1])

      await expect(createCampaign(input, ADMIN)).resolves.toBe(
        '群发任务 #5 还没有结束, 等它发完或取消之后才能再发起'
      )

      expect(campaigns).toHaveLength(1)
      expect(rec.attempts.at(-1)).toMatchObject({
        committed: false,
        rolledBack: true
      })
      expect(statementsNamed('mail_campaign.create')).toHaveLength(0)
    }
  )

  it.each(['done', 'cancelled'])(
    '上一个任务已经%s时可以再发起',
    async (status) => {
      campaigns = [campaignRow({ id: 5, status })]
      users = userRows([1])

      await expect(createCampaign(input, ADMIN)).resolves.toEqual({
        campaignId: 6
      })
    }
  )

  it('一个用户都没有时范围为空, 任务照建', async () => {
    await expect(createCampaign(input, ADMIN)).resolves.toEqual({
      campaignId: 1
    })

    expect(campaigns[0]).toMatchObject({ max_user_id: 0, total: 0 })
  })
})

describe('transitionCampaign', () => {
  it.each(['sending', 'paused'])('取消%s的任务', async (status) => {
    campaigns = [campaignRow({ status, cursor_user_id: 30, sent: 30 })]

    await expect(transitionCampaign(7, 'cancel', ADMIN)).resolves.toEqual({})

    expect(campaigns[0]).toMatchObject({
      status: 'cancelled',
      cursor_user_id: 30,
      finished: expect.any(Date)
    })
    expect(committedLogs()).toEqual([
      {
        type: 'update',
        user_id: 1,
        content: '管理员 鲲 取消了群发邮件任务 #7'
      }
    ])
  })

  it.each(['done', 'cancelled'])(
    '已经%s的任务不能再取消, 不记日志',
    async (status) => {
      const finished = new Date('2026-11-21T00:00:00Z')
      campaigns = [campaignRow({ status, finished })]

      await expect(transitionCampaign(7, 'cancel', ADMIN)).resolves.toBe(
        '这个群发任务已经结束了'
      )

      expect(campaigns[0]).toMatchObject({ status, finished })
      expect(committedLogs()).toEqual([])
    }
  )

  it('继续发送把暂停的任务放回发送中, 清掉暂停原因, 游标不动', async () => {
    campaigns = [
      campaignRow({
        status: 'paused',
        cursor_user_id: 30,
        last_error: '一批 3 封里有 3 封发送失败'
      })
    ]

    await expect(transitionCampaign(7, 'resume', ADMIN)).resolves.toEqual({})

    expect(campaigns[0]).toMatchObject({
      status: 'sending',
      cursor_user_id: 30,
      last_error: '',
      finished: null
    })
    expect(committedLogs()).toEqual([
      {
        type: 'update',
        user_id: 1,
        content: '管理员 鲲 继续发送群发邮件任务 #7'
      }
    ])
  })

  it.each(['sending', 'done', 'cancelled'])(
    '%s的任务不能「继续发送」',
    async (status) => {
      campaigns = [campaignRow({ status })]

      await expect(transitionCampaign(7, 'resume', ADMIN)).resolves.toBe(
        '只有暂停中的群发任务可以继续发送'
      )

      expect(campaigns[0].status).toBe(status)
      expect(committedLogs()).toEqual([])
    }
  )

  it('任务不存在时按已结束处理', async () => {
    await expect(transitionCampaign(404, 'cancel', ADMIN)).resolves.toBe(
      '这个群发任务已经结束了'
    )
  })
})

describe('listCampaigns', () => {
  it('按新旧倒序给出最近几条的进度, 不带正文', async () => {
    campaigns = [
      campaignRow({ id: 1, status: 'done', sent: 9, total: 10 }),
      campaignRow({
        id: 2,
        status: 'paused',
        created_by: null,
        last_error: '中继不可用'
      }),
      campaignRow({ id: 3, status: 'cancelled' })
    ]

    const listed = await listCampaigns(2)

    expect(listed).toEqual([
      expect.objectContaining({ id: 3, status: 'cancelled' }),
      {
        id: 2,
        templateId: 'touchgal',
        title: '停机维护通知',
        status: 'paused',
        total: 0,
        sent: 0,
        failed: 0,
        lastError: '中继不可用',
        creator: null,
        created: new Date('2026-11-22T00:00:00Z'),
        finished: null
      }
    ])
    const [query] = statementsNamed('mail_campaign.findMany')
    expect(query.orderBy).toEqual({ id: 'desc' })
    expect(query.select).not.toHaveProperty('content_html')
  })
})
