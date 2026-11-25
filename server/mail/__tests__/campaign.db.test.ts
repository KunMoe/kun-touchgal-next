import { randomUUID } from 'crypto'
import pg from 'pg'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { KUN_ROLE } from '~/constants/role'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'

// 群发任务在真实 PostgreSQL 上的行为 (运行方式见 server/db/__tests__/dbContract.ts)。
// 单测里的内存替身与编译契约都证明不了这三件事:
// - 「没有进行中的任务才能新建」是通告锁下的查后插, 并发的创建确实在那把锁上排队
// - 推进游标的条件更新排在行锁后面时, 库在这一行上重新求值它的 WHERE: 期间提交的取消、
//   另一个进程的推进都能让它命中 0 行
// - 时间列、外键与关系查询在真表上是预期的样子

const { sendKunEmailMock } = vi.hoisted(() => ({
  sendKunEmailMock: vi.fn()
}))

// 绝不真的发信
vi.mock('~/app/api/utils/sendKunEmail', () => ({
  sendKunEmail: sendKunEmailMock
}))

// 一批 3 封、批间不等待
vi.mock('~/constants/admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/constants/admin')>()),
  MAIL_CAMPAIGN_BATCH_SIZE: 3,
  MAIL_CAMPAIGN_MIN_BATCH_INTERVAL_MS: 0
}))

// 每个并发的创建都要占一条池里的连接等锁, 连接池上限是 10
const CONCURRENCY = 5

// 这个文件写的管理日志都带这几个字; 清理与计数只看它们
const CAMPAIGN_LOGS = { content: { contains: '群发邮件任务' } }

const input = {
  templateId: 'touchgal' as const,
  title: '停机维护通知',
  contentHtml: '<p>今晚维护</p>'
}

describe.skipIf(!dbContractUrl)('mail campaign on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let campaign: typeof import('~/server/mail/campaign')
  let createdUserIds: number[] = []
  const clients: pg.Client[] = []

  beforeAll(async () => {
    prisma = await openDbContract()
    campaign = await import('~/server/mail/campaign')
  })

  beforeEach(() => {
    sendKunEmailMock.mockReset()
    sendKunEmailMock.mockResolvedValue(undefined)
    vi.stubEnv('KUN_EMAIL_UNSUBSCRIBE_SECRET', 'k'.repeat(32))
    vi.stubEnv('NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD', 'https://www.example.com')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    // 先收连接: 失败的用例可能还握着锁, 不收的话下面的删除会一直等
    await Promise.all(clients.splice(0).map((client) => client.end()))
    await prisma.mail_campaign.deleteMany({})
    await prisma.admin_log.deleteMany({ where: CAMPAIGN_LOGS })
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    createdUserIds = []
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  const connect = async () => {
    const client = new pg.Client({ connectionString: dbContractUrl })
    await client.connect()
    clients.push(client)
    return client
  }

  const newUsers = async (count: number) => {
    const created = []
    for (let i = 0; i < count; i++) {
      const user = await prisma.user.create({
        data: {
          name: randomUUID().slice(0, 17),
          email: `${randomUUID()}@example.com`,
          password: 'hash'
        },
        omit: { email: false }
      })
      createdUserIds.push(user.id)
      created.push(user)
    }
    return created
  }

  const actorOf = (user: { id: number; name: string }) =>
    kunTestActor({
      uid: user.id,
      role: KUN_ROLE.SUPER_ADMIN,
      name: user.name
    })

  const theCampaign = () =>
    prisma.mail_campaign.findFirstOrThrow({ orderBy: { id: 'desc' } })

  const neverAborted = () => new AbortController().signal

  const campaignLogs = () =>
    prisma.admin_log.findMany({ where: CAMPAIGN_LOGS, orderBy: { id: 'asc' } })

  const mailedAddresses = () =>
    sendKunEmailMock.mock.calls.map(([payload]) => payload.to[0] as string)

  // 等到恰有 expected 个会话排在锁上。观察用的连接不开事务: pg_stat_activity 在同一个事务
  // 里读到的是第一次读取时的快照
  const waitForLockWaiters = async (observer: pg.Client, expected: number) => {
    for (let i = 0; ; i++) {
      const { rows } = await observer.query<{
        wait_event_type: string | null
        query: string
      }>(
        `SELECT wait_event_type, left(query, 80) AS query
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()`
      )
      const waiting = rows.filter((row) => row.wait_event_type === 'Lock')
      if (waiting.length === expected) {
        return
      }
      // 上限要低于用例的超时 (默认 5 秒), 否则先到的是超时, 这条带现场的错误出不来
      if (i > 150) {
        throw new Error(
          `等了 3 秒只有 ${waiting.length}/${expected} 个会话排在锁上: ${JSON.stringify(rows)}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('并发的创建都排在通告锁 (481005, 0) 后面: 恰好一个建成, 其余被告知已有任务', async () => {
    const [admin] = await newUsers(1)
    const [holder, observer] = [await connect(), await connect()]
    await holder.query('BEGIN')
    await holder.query('SELECT pg_advisory_xact_lock(481005, 0)')

    const pending = Array.from({ length: CONCURRENCY }, () =>
      campaign.createCampaign(input, actorOf(admin))
    )
    const settled = Promise.allSettled(pending)
    try {
      // 少一个都说明有创建没有去拿这把锁 (或拿的不是这一把)
      await waitForLockWaiters(observer, CONCURRENCY)
    } finally {
      await holder.query('COMMIT')
      await settled
    }
    const results = await Promise.all(pending)

    const created = results.filter((result) => typeof result !== 'string')
    expect(created).toHaveLength(1)
    for (const rejected of results.filter(
      (result) => typeof result === 'string'
    )) {
      expect(rejected).toContain('还没有结束')
    }
    await expect(prisma.mail_campaign.count()).resolves.toBe(1)
    // 被拒绝的创建整个回滚了, 日志只有建成的那一条
    await expect(campaignLogs()).resolves.toHaveLength(1)
  })

  it('从创建到发完: 只发给范围内开着通知的用户, 计数、游标、时间与日志落在任务行上', async () => {
    const users = await newUsers(7)
    const [admin] = users
    await prisma.user.update({
      where: { id: users[2].id },
      data: { enable_email_notice: false }
    })

    const created = await campaign.createCampaign(input, actorOf(admin))
    expect(created).toEqual({ campaignId: expect.any(Number) })
    await expect(theCampaign()).resolves.toMatchObject({
      status: 'sending',
      site_origin: 'https://www.example.com',
      max_user_id: users[6].id,
      cursor_user_id: 0,
      total: 6,
      sent: 0,
      created_by: admin.id
    })

    // 创建之后才注册的用户不在这次群发里; 发送途中退订的人轮到时不再发
    const [late] = await newUsers(1)
    sendKunEmailMock.mockImplementationOnce(async () => {
      await prisma.user.update({
        where: { id: users[5].id },
        data: { enable_email_notice: false }
      })
    })
    const before = Date.now()

    await expect(
      campaign.runCampaignStep({ signal: neverAborted() })
    ).resolves.toMatchObject({ kind: 'done', sent: 5, failed: 0 })

    const recipients = [users[0], users[1], users[3], users[4], users[6]]
    expect(mailedAddresses()).toEqual(recipients.map((user) => user.email))
    expect(mailedAddresses()).not.toContain(late.email)

    const done = await theCampaign()
    expect(done).toMatchObject({
      status: 'done',
      cursor_user_id: users[6].id,
      sent: 5,
      failed: 0,
      total: 6
    })
    // 时间列读回来仍是此刻 (UTC 墙钟往返, 不随库的会话时区偏移)
    for (const time of [done.created, done.updated, done.finished]) {
      expect(time).toBeInstanceOf(Date)
      expect(Math.abs((time as Date).getTime() - before)).toBeLessThan(60_000)
    }

    const logs = await campaignLogs()
    expect(logs.map((log) => [log.type, log.user_id])).toEqual([
      ['create', admin.id],
      ['update', admin.id]
    ])
    expect(logs[1].content).toContain('成功 5 封, 失败 0 封')

    await expect(campaign.listCampaigns(10)).resolves.toEqual([
      expect.objectContaining({
        id: done.id,
        status: 'done',
        runsHere: true,
        creator: { id: admin.id, name: admin.name, avatar: '' }
      })
    ])

    // 发完之后没有进行中的任务, 可以再发起
    await expect(
      campaign.createCampaign(input, actorOf(admin))
    ).resolves.toEqual({ campaignId: expect.any(Number) })
  })

  it('发起的管理员账号被删除后任务行留下, 只断开归属', async () => {
    const [admin] = await newUsers(1)
    await campaign.createCampaign(input, actorOf(admin))

    await prisma.user.delete({ where: { id: admin.id } })

    await expect(theCampaign()).resolves.toMatchObject({
      status: 'sending',
      created_by: null
    })
    await expect(campaign.listCampaigns(10)).resolves.toEqual([
      expect.objectContaining({ creator: null })
    ])
  })

  it('取消已经拿到行锁、还没提交时这一拍开始: 发信之前的认领排在行锁后面, 取消提交后它命中 0 行, 一封都不发', async () => {
    const users = await newUsers(4)
    const created = await campaign.createCampaign(input, actorOf(users[0]))
    const { campaignId } = created as { campaignId: number }
    const [holder, observer] = [await connect(), await connect()]

    // 这一拍开头读到的仍是发送中: 取消还没提交
    await holder.query('BEGIN')
    await holder.query(
      `UPDATE mail_campaign SET status = 'cancelled' WHERE id = $1`,
      [campaignId]
    )

    const pending = campaign.runCampaignStep({ signal: neverAborted() })
    const settled = Promise.allSettled([pending])
    try {
      await waitForLockWaiters(observer, 1)
    } finally {
      await holder.query('COMMIT')
      await settled
    }

    await expect(pending).resolves.toEqual({
      kind: 'stopped',
      campaignId,
      sent: 0,
      failed: 0
    })
    expect(sendKunEmailMock).not.toHaveBeenCalled()
    await expect(theCampaign()).resolves.toMatchObject({
      status: 'cancelled',
      cursor_user_id: 0,
      sent: 0
    })
  })

  it('一批发出途中任务被取消: 这一批补记到已取消的任务行上, 不再取下一批', async () => {
    const users = await newUsers(5)
    const admin = actorOf(users[0])
    const created = await campaign.createCampaign(input, admin)
    const { campaignId } = created as { campaignId: number }
    sendKunEmailMock.mockImplementationOnce(async () => {
      await campaign.transitionCampaign(campaignId, 'cancel', admin)
    })

    await expect(
      campaign.runCampaignStep({ signal: neverAborted() })
    ).resolves.toEqual({ kind: 'stopped', campaignId, sent: 3, failed: 0 })

    // 这一批已经发出去了 (至少一次), 数字与实际发出的对得上
    expect(mailedAddresses()).toEqual(
      users.slice(0, 3).map((user) => user.email)
    )
    await expect(theCampaign()).resolves.toMatchObject({
      status: 'cancelled',
      cursor_user_id: users[2].id,
      sent: 3,
      failed: 0
    })
    // 取消之后没有任何进程再碰它
    await expect(
      campaign.runCampaignStep({ signal: neverAborted() })
    ).resolves.toEqual({ kind: 'idle' })
  })

  it('收件范围已经发完、收尾排在取消的行锁后面: 取消提交后收尾命中 0 行, 不标完成也不记完成日志', async () => {
    const users = await newUsers(2)
    const created = await campaign.createCampaign(input, actorOf(users[0]))
    const { campaignId } = created as { campaignId: number }
    await prisma.mail_campaign.update({
      where: { id: campaignId },
      data: { cursor_user_id: users[1].id, sent: 2 }
    })
    const [holder, observer] = [await connect(), await connect()]

    await holder.query('BEGIN')
    await holder.query(
      `UPDATE mail_campaign SET status = 'cancelled' WHERE id = $1`,
      [campaignId]
    )

    const pending = campaign.runCampaignStep({ signal: neverAborted() })
    const settled = Promise.allSettled([pending])
    try {
      await waitForLockWaiters(observer, 1)
    } finally {
      await holder.query('COMMIT')
      await settled
    }

    await expect(pending).resolves.toEqual({
      kind: 'stopped',
      campaignId,
      sent: 0,
      failed: 0
    })
    await expect(theCampaign()).resolves.toMatchObject({
      status: 'cancelled',
      finished: null
    })
    const logs = await campaignLogs()
    expect(logs.map((log) => log.type)).toEqual(['create'])
  })

  it('两个进程同时推进同一个任务: 恰好一个推进成功, 计数只记一次, 重复不超过一批', async () => {
    const users = await newUsers(3)
    const created = await campaign.createCampaign(input, actorOf(users[0]))
    const { campaignId } = created as { campaignId: number }
    const [holder, observer] = [await connect(), await connect()]

    await holder.query('BEGIN')
    await holder.query('SELECT 1 FROM mail_campaign WHERE id = $1 FOR UPDATE', [
      campaignId
    ])

    // 两边读到同一个游标, 发信之前的认领一起排在行锁后面; 放行后各发了同一批, 再各自推进
    const pending = [
      campaign.runCampaignStep({ signal: neverAborted() }),
      campaign.runCampaignStep({ signal: neverAborted() })
    ]
    const settled = Promise.allSettled(pending)
    try {
      await waitForLockWaiters(observer, 2)
    } finally {
      await holder.query('COMMIT')
      await settled
    }
    const results = await Promise.all(pending)

    expect(results.map((result) => result.kind).sort()).toEqual([
      'done',
      'stopped'
    ])
    expect(mailedAddresses()).toHaveLength(6)
    // 计数只记了一次, 完成日志也只有一条
    await expect(theCampaign()).resolves.toMatchObject({
      status: 'done',
      cursor_user_id: users[2].id,
      sent: 3,
      failed: 0
    })
    const logs = await campaignLogs()
    expect(logs.filter((log) => log.type === 'update')).toHaveLength(1)
  })

  it('失败过半自动暂停在这一批之前; 继续发送把这一批整批重发, 没有人被跳过', async () => {
    const users = await newUsers(5)
    const admin = actorOf(users[0])
    const created = await campaign.createCampaign(input, admin)
    const { campaignId } = created as { campaignId: number }
    sendKunEmailMock.mockResolvedValue('邮件发送失败, 请稍后重试')

    await expect(
      campaign.runCampaignStep({ signal: neverAborted() })
    ).resolves.toMatchObject({ kind: 'paused', sent: 0, failed: 0 })
    const paused = await theCampaign()
    expect(paused).toMatchObject({
      status: 'paused',
      cursor_user_id: 0,
      sent: 0,
      failed: 0,
      finished: null
    })
    expect(paused.last_error).toContain('一批 3 封里有 3 封发送失败')

    // 暂停的任务不会自己动, 也挡着新任务
    await expect(
      campaign.runCampaignStep({ signal: neverAborted() })
    ).resolves.toEqual({ kind: 'idle' })
    await expect(campaign.createCampaign(input, admin)).resolves.toContain(
      '还没有结束'
    )

    sendKunEmailMock.mockReset()
    sendKunEmailMock.mockResolvedValue(undefined)
    await expect(
      campaign.transitionCampaign(campaignId, 'resume', admin)
    ).resolves.toEqual({})
    await expect(
      campaign.runCampaignStep({ signal: neverAborted() })
    ).resolves.toMatchObject({ kind: 'done', sent: 5, failed: 0 })

    expect(mailedAddresses()).toEqual(users.map((user) => user.email))
    await expect(theCampaign()).resolves.toMatchObject({
      status: 'done',
      sent: 5,
      failed: 0,
      last_error: ''
    })
  })

  it('取消之后任务不再被推进, 也不能再继续', async () => {
    const users = await newUsers(2)
    const admin = actorOf(users[0])
    const created = await campaign.createCampaign(input, admin)
    const { campaignId } = created as { campaignId: number }

    await expect(
      campaign.transitionCampaign(campaignId, 'cancel', admin)
    ).resolves.toEqual({})

    await expect(
      campaign.runCampaignStep({ signal: neverAborted() })
    ).resolves.toEqual({ kind: 'idle' })
    expect(sendKunEmailMock).not.toHaveBeenCalled()
    await expect(
      campaign.transitionCampaign(campaignId, 'resume', admin)
    ).resolves.toBe('只有暂停中的群发任务可以继续发送')
    await expect(
      campaign.transitionCampaign(campaignId, 'cancel', admin)
    ).resolves.toBe('这个群发任务已经结束了')
    await expect(theCampaign()).resolves.toMatchObject({
      status: 'cancelled',
      finished: expect.any(Date)
    })
  })
})
