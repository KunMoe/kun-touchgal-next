import { randomUUID } from 'crypto'
import pg from 'pg'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { KUN_ROLE } from '~/constants/role'

// 账号删除在真实 PostgreSQL 上的行为 (运行方式见 server/db/__tests__/dbContract.ts)。
// 收尾的完备性论证 (user 行 FOR UPDATE 挡住一切引用它的插入) 与级联 / 置空 / 触发器的实际
// 效果, mock 都测不出来。库外副作用 (Redis、搜索引擎、S3) 换成假实现, 出箱入队照常写库

const redis = await vi.hoisted(async () =>
  (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
)

vi.mock('~/lib/redis', () => redis.module)
// 没有搜索引擎: 提交后的入队与即时消费都跳过, 事务内的 search_outbox 入队照常写库
vi.mock('~/lib/meilisearch', () => ({ getMeiliClient: () => null }))
vi.mock('~/lib/s3', () => ({
  deleteFileFromS3: vi.fn(),
  copyObject: vi.fn(),
  uploadImageToS3: vi.fn()
}))
// 出箱的即时消费会把这里要断言的出箱行删掉, 只留入队
vi.mock('~/server/storage/s3Outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/storage/s3Outbox')>()),
  kickS3DeletionDrain: vi.fn()
}))

const INSERT_RESOURCE = `
  INSERT INTO patch_resource (section, user_id, patch_id, updated)
  VALUES ('patch', $1, $2, now())
  RETURNING id`

describe.skipIf(!dbContractUrl)('account deletion on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let account: typeof import('~/server/account/deleteAccount')
  let userIds: number[] = []
  let patchIds: number[] = []
  let s3Keys: string[] = []
  let baseline = { adminLog: 0, tag: 0, company: 0, blacklist: 0 }

  const maxId = async (table: string) => {
    const [row] = await prisma.$queryRawUnsafe<{ max: number | null }[]>(
      `SELECT max(id) AS max FROM ${table}`
    )
    return row.max ?? 0
  }

  beforeAll(async () => {
    prisma = await openDbContract()
    account = await import('~/server/account/deleteAccount')
    baseline = {
      adminLog: await maxId('admin_log'),
      tag: await maxId('patch_tag'),
      company: await maxId('patch_company'),
      blacklist: await maxId('moderation_blacklist')
    }
  })

  afterEach(async () => {
    // 置空归属的行不随 user 级联, 按本文件建行之前的最大 id 清
    await prisma.admin_log.deleteMany({
      where: { id: { gt: baseline.adminLog } }
    })
    await prisma.patch_tag.deleteMany({ where: { id: { gt: baseline.tag } } })
    await prisma.patch_company.deleteMany({
      where: { id: { gt: baseline.company } }
    })
    await prisma.moderation_blacklist.deleteMany({
      where: { id: { gt: baseline.blacklist } }
    })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.search_outbox.deleteMany({
      where: { patch_id: { in: patchIds } }
    })
    await prisma.s3_deletion_outbox.deleteMany({
      where: { s3_key: { in: s3Keys } }
    })
    userIds = []
    patchIds = []
    s3Keys = []
    redis.reset()
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  const newUser = async (role: number = KUN_ROLE.USER) => {
    const user = await prisma.user.create({
      data: {
        name: randomUUID().slice(0, 17),
        email: `${randomUUID()}@example.com`,
        password: 'x',
        role
      }
    })
    userIds.push(user.id)
    return user
  }

  const newPatch = async (userId: number) => {
    const patch = await prisma.patch.create({
      data: {
        unique_id: randomUUID().slice(0, 8),
        name: 'account deletion contract',
        user_id: userId
      }
    })
    patchIds.push(patch.id)
    return patch
  }

  // 公开资源; 给了 withS3 就带一条 s3 链接, 返回它的 s3_key
  const newResource = async (
    userId: number,
    patchId: number,
    withS3: boolean
  ) => {
    const s3Key = `patch/${patchId}/resource/${randomUUID()}/file.zip`
    const resource = await prisma.patch_resource.create({
      data: {
        section: 'patch',
        user_id: userId,
        patch_id: patchId,
        links: withS3
          ? {
              create: {
                storage: 's3',
                s3_key: s3Key,
                content: `https://cloud.example.test/${s3Key}`
              }
            }
          : undefined
      }
    })
    if (withS3) {
      s3Keys.push(s3Key)
    }
    return { resource, s3Key }
  }

  const newComment = (userId: number, patchId: number, parentId?: number) =>
    prisma.patch_comment.create({
      data: {
        content: 'c',
        user_id: userId,
        patch_id: patchId,
        parent_id: parentId ?? null
      }
    })

  const newRating = (userId: number, patchId: number) =>
    prisma.patch_rating.create({
      data: { recommend: 'yes', overall: 8, user_id: userId, patch_id: patchId }
    })

  // 目标用户 T、他人 O、执行删除的超级管理员 A。T 建档 P1, O 建档 P2
  const buildFixture = async () => {
    const admin = await newUser(KUN_ROLE.SUPER_ADMIN)
    const other = await newUser()
    const target = await newUser()
    const p1 = await newPatch(target.id)
    const p2 = await newPatch(other.id)

    // P1 下他人的内容: 随 P1 一起删
    const otherOnP1 = {
      resource: await newResource(other.id, p1.id, true),
      comment: await newComment(other.id, p1.id),
      rating: await newRating(other.id, p1.id)
    }

    // T 挂在 P2 下的内容, 以及他点赞过的 O 的资源与评论
    const targetOnP2 = {
      resource: await newResource(target.id, p2.id, true),
      comment: await newComment(target.id, p2.id),
      rating: await newRating(target.id, p2.id)
    }
    const otherReply = await newComment(other.id, p2.id, targetOnP2.comment.id)
    const otherResourceOnP2 = await newResource(other.id, p2.id, false)
    const otherCommentOnP2 = await newComment(other.id, p2.id)
    await prisma.user_patch_resource_like_relation.create({
      data: {
        user_id: target.id,
        resource_id: otherResourceOnP2.resource.id
      }
    })
    await prisma.user_patch_comment_like_relation.create({
      data: { user_id: target.id, comment_id: otherCommentOnP2.id }
    })
    await prisma.user_patch_favorite_folder.create({
      data: {
        name: 'fav',
        user_id: target.id,
        patch: { create: { patch_id: p2.id } }
      }
    })
    await prisma.user_follow_relation.createMany({
      data: [
        { follower_id: target.id, following_id: other.id },
        { follower_id: other.id, following_id: target.id }
      ]
    })
    await prisma.user_message.create({
      data: {
        type: 'follow',
        content: 'm',
        sender_id: target.id,
        recipient_id: other.id
      }
    })

    // T 建的共享词条与他写的审计、黑名单: 删号后保留, 归属置空
    const authored = {
      tag: await prisma.patch_tag.create({
        data: {
          name: `tag-${randomUUID()}`,
          user_id: target.id,
          patch_relation: { create: { patch_id: p2.id } }
        }
      }),
      company: await prisma.patch_company.create({
        data: {
          name: `company-${randomUUID()}`,
          user_id: target.id,
          patch_relations: { create: { patch_id: p2.id } }
        }
      }),
      blacklist: await prisma.moderation_blacklist.create({
        data: { pattern: `p-${randomUUID()}`, user_id: target.id }
      }),
      adminLog: await prisma.admin_log.create({
        data: { type: 'update', content: 'by target', user_id: target.id }
      })
    }

    const actor = kunTestActor({
      uid: admin.id,
      role: KUN_ROLE.SUPER_ADMIN,
      name: admin.name
    })
    const avatarKeys = [
      `user/avatar/user_${target.id}/avatar.avif`,
      `user/avatar/user_${target.id}/avatar-mini.avif`
    ]
    s3Keys.push(...avatarKeys)

    return {
      admin,
      other,
      target,
      p1,
      p2,
      otherOnP1,
      targetOnP2,
      otherReply,
      otherResourceOnP2,
      otherCommentOnP2,
      authored,
      actor,
      avatarKeys
    }
  }

  describe('收尾的锁契约', () => {
    const connect = async () => {
      const client = new pg.Client({ connectionString: dbContractUrl })
      await client.connect()
      return client
    }

    it('持有 user 行 FOR UPDATE 期间, 引用该用户的插入拿不到外键锁', async () => {
      const target = await newUser()
      const owner = await newUser()
      const patch = await newPatch(owner.id)
      const a = await connect()
      const b = await connect()
      try {
        await a.query('BEGIN')
        await a.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [
          target.id
        ])

        await b.query('BEGIN')
        await b.query("SET LOCAL lock_timeout = '300ms'")
        const blocked = await b
          .query(INSERT_RESOURCE, [target.id, patch.id])
          .then(
            () => null,
            (error: { code?: string }) => error
          )
        expect(blocked?.code).toBe('55P03')
        await b.query('ROLLBACK')

        // 锁一放, 同一条插入照常成功: 挡住它的是锁, 不是别的约束
        await a.query('ROLLBACK')
        const inserted = await b.query(INSERT_RESOURCE, [target.id, patch.id])
        expect(inserted.rows).toHaveLength(1)
      } finally {
        await a.end()
        await b.end()
      }
    })

    it('持锁一方删掉 user 行并提交, 排队中的插入以外键错误失败', async () => {
      const target = await newUser()
      const owner = await newUser()
      const patch = await newPatch(owner.id)
      const a = await connect()
      const b = await connect()
      try {
        await a.query('BEGIN')
        await a.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [
          target.id
        ])

        const {
          rows: [{ pid }]
        } = await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        const pending = b.query(INSERT_RESOURCE, [target.id, patch.id]).then(
          () => null,
          (error: { code?: string; constraint?: string }) => error
        )

        // 等 B 确实排在 user 行的锁上, 再提交删除
        for (let i = 0; ; i++) {
          const [activity] = await prisma.$queryRaw<
            { wait_event_type: string | null }[]
          >`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`
          if (activity?.wait_event_type === 'Lock') {
            break
          }
          if (i > 100) {
            throw new Error('插入方没有进入锁等待')
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }

        await a.query('DELETE FROM "user" WHERE id = $1', [target.id])
        await a.query('COMMIT')

        const failed = await pending
        expect(failed?.code).toBe('23503')
        expect(failed?.constraint).toBe('patch_resource_user_id_fkey')
        expect(
          await prisma.patch_resource.count({ where: { user_id: target.id } })
        ).toBe(0)
      } finally {
        await a.end()
        await b.end()
      }
    })
  })

  it('端到端: 清除、级联、置空与出箱都落在库里', async () => {
    const f = await buildFixture()
    expect(
      (await prisma.patch.findUniqueOrThrow({ where: { id: f.p2.id } }))
        .favorite_count
    ).toBe(1)

    const result = await account.deleteAccount(f.target.id, f.actor)

    expect(result).toEqual({ done: true })
    expect(await prisma.user.findUnique({ where: { id: f.target.id } })).toBe(
      null
    )

    // 建档的游戏连同他人挂在下面的内容一起删
    expect(await prisma.patch.findUnique({ where: { id: f.p1.id } })).toBe(null)
    expect(
      await prisma.patch_resource.findUnique({
        where: { id: f.otherOnP1.resource.resource.id }
      })
    ).toBe(null)
    expect(
      await prisma.patch_comment.findUnique({
        where: { id: f.otherOnP1.comment.id }
      })
    ).toBe(null)
    expect(
      await prisma.patch_rating.findUnique({
        where: { id: f.otherOnP1.rating.id }
      })
    ).toBe(null)

    // 他人游戏上的本人内容删掉 (评论连同他人的回复), 他人的内容留着
    const p2 = await prisma.patch.findUniqueOrThrow({ where: { id: f.p2.id } })
    expect(
      await prisma.patch_resource.findUnique({
        where: { id: f.targetOnP2.resource.resource.id }
      })
    ).toBe(null)
    expect(
      await prisma.patch_comment.findMany({
        where: { id: { in: [f.targetOnP2.comment.id, f.otherReply.id] } }
      })
    ).toEqual([])
    expect(
      await prisma.patch_rating.findUnique({
        where: { id: f.targetOnP2.rating.id }
      })
    ).toBe(null)
    expect(
      await prisma.patch_resource.findUnique({
        where: { id: f.otherResourceOnP2.resource.id }
      })
    ).not.toBe(null)
    expect(
      await prisma.patch_comment.findUnique({
        where: { id: f.otherCommentOnP2.id }
      })
    ).not.toBe(null)
    // 收藏夹两级级联经触发器递减收藏数; 评价统计按剩下的公开评价重算
    expect(p2.favorite_count).toBe(0)
    expect(
      (
        await prisma.patch_rating_stat.findUnique({
          where: { patch_id: f.p2.id }
        })
      )?.count ?? 0
    ).toBe(0)

    // cascade 类随 user 行由库删掉
    expect(
      await prisma.user_follow_relation.count({
        where: {
          OR: [{ follower_id: f.target.id }, { following_id: f.target.id }]
        }
      })
    ).toBe(0)
    expect(
      await prisma.user_message.count({ where: { sender_id: f.target.id } })
    ).toBe(0)
    expect(
      await prisma.user_patch_favorite_folder.count({
        where: { user_id: f.target.id }
      })
    ).toBe(0)

    // set-null 类: 行保留, 归属置空; 标签与会社仍挂在 P2 上
    const tag = await prisma.patch_tag.findUniqueOrThrow({
      where: { id: f.authored.tag.id },
      include: { patch_relation: true }
    })
    expect(tag.user_id).toBe(null)
    expect(tag.patch_relation.map((relation) => relation.patch_id)).toEqual([
      f.p2.id
    ])
    const company = await prisma.patch_company.findUniqueOrThrow({
      where: { id: f.authored.company.id },
      include: { patch_relations: true }
    })
    expect(company.user_id).toBe(null)
    expect(company.patch_relations).toHaveLength(1)
    expect(
      (
        await prisma.moderation_blacklist.findUniqueOrThrow({
          where: { id: f.authored.blacklist.id }
        })
      ).user_id
    ).toBe(null)
    expect(
      (
        await prisma.admin_log.findUniqueOrThrow({
          where: { id: f.authored.adminLog.id }
        })
      ).user_id
    ).toBe(null)

    // 两个正式头像 key 与被删资源的 s3 对象都进了删除出箱
    const outbox = await prisma.s3_deletion_outbox.findMany({
      where: { s3_key: { in: s3Keys } },
      select: { s3_key: true }
    })
    expect(outbox.map((row) => row.s3_key).sort()).toEqual(
      [
        ...f.avatarKeys,
        f.otherOnP1.resource.s3Key,
        f.targetOnP2.resource.s3Key
      ].sort()
    )

    // 审计: 开始与收尾各一条, 都记在执行删除的管理员名下
    const logs = await prisma.admin_log.findMany({
      where: { user_id: f.admin.id },
      orderBy: { id: 'asc' },
      select: { content: true }
    })
    expect(logs[0].content).toContain('开始删除一个用户')
    expect(logs.at(-1)?.content).toContain('删除了一个用户')

    // 他人账号不受影响
    const other = await prisma.user.findUniqueOrThrow({
      where: { id: f.other.id }
    })
    expect(other.status).toBe(f.other.status)
  })

  it('预算用尽: 先封禁、内容原样留着, 再请求一次续删完成', async () => {
    const f = await buildFixture()

    const first = await account.deleteAccount(f.target.id, f.actor, {
      budgetMs: 0
    })

    expect(first).toEqual({
      done: false,
      remaining: {
        'patch.user_id': 1,
        'patch_resource.user_id': 1,
        'patch_comment.user_id': 1,
        'patch_rating.user_id': 1
      }
    })
    const banned = await prisma.user.findUniqueOrThrow({
      where: { id: f.target.id }
    })
    expect(banned.status).toBe(2)
    expect(await prisma.patch.findUnique({ where: { id: f.p1.id } })).not.toBe(
      null
    )
    expect(
      await prisma.patch_comment.findUnique({
        where: { id: f.targetOnP2.comment.id }
      })
    ).not.toBe(null)

    const second = await account.deleteAccount(f.target.id, f.actor)

    expect(second).toEqual({ done: true })
    expect(await prisma.user.findUnique({ where: { id: f.target.id } })).toBe(
      null
    )
    expect(await prisma.patch.findUnique({ where: { id: f.p1.id } })).toBe(null)
  })
})
