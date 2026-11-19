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

// 重新编辑在真实 PostgreSQL 上的行为 (运行方式见 server/db/__tests__/dbContract.ts)。
// 并发令牌靠 patch 行锁下的读成立, 字段与别名的原子性靠同一个事务的回滚: 两件事 mock 都
// 测不出来。库外副作用 (Redis、搜索引擎) 换成假实现, 出箱入队照常写库

const redis = await vi.hoisted(async () =>
  (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
)
// 让下一次手动标签步骤失败: 模拟「主事务已提交、后面的标签步骤失败」
const tagStep = vi.hoisted(() => ({ failNext: false }))

vi.mock('~/lib/redis', () => redis.module)
vi.mock('~/lib/meilisearch', () => ({ getMeiliClient: () => null }))
vi.mock('~/app/api/edit/batchTag', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/app/api/edit/batchTag')>()
  return {
    ...real,
    saveManualTagChange: (
      ...args: Parameters<typeof real.saveManualTagChange>
    ) => {
      if (tagStep.failNext) {
        tagStep.failNext = false
        return Promise.reject(new Error('tag step failed'))
      }
      return real.saveManualTagChange(...args)
    }
  }
})

const CONFLICT = '该游戏在您打开编辑页之后已被修改, 请刷新后重试'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!dbContractUrl)('galgame rewrite on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let updateGalgame: typeof import('~/app/api/edit/update').updateGalgame
  let getGalgameForRewrite: typeof import('~/app/api/edit/rewriteData').getGalgameForRewrite
  let userIds: number[] = []
  let patchIds: number[] = []
  let tagBaseline = 0

  beforeAll(async () => {
    prisma = await openDbContract()
    ;({ updateGalgame } = await import('~/app/api/edit/update'))
    ;({ getGalgameForRewrite } = await import('~/app/api/edit/rewriteData'))
    const newest = await prisma.patch_tag.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true }
    })
    tagBaseline = newest?.id ?? 0
  })

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.patch_tag.deleteMany({ where: { id: { gt: tagBaseline } } })
    await prisma.search_outbox.deleteMany({
      where: { patch_id: { in: patchIds } }
    })
    userIds = []
    patchIds = []
    tagStep.failNext = false
    redis.reset()
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  const newUser = async () => {
    const user = await prisma.user.create({
      data: {
        name: randomUUID().slice(0, 17),
        email: `${randomUUID()}@example.com`,
        password: 'x'
      }
    })
    userIds.push(user.id)
    return user
  }

  const newPatch = async (userId: number, alias: string[] = ['原别名']) => {
    const patch = await prisma.patch.create({
      data: {
        unique_id: randomUUID().slice(0, 8),
        name: '改之前的名字',
        introduction: '改之前的游戏介绍文本, 足够长',
        content_limit: 'sfw',
        released: '2025-12-31',
        user_id: userId,
        alias: { create: alias.map((name) => ({ name })) }
      }
    })
    patchIds.push(patch.id)
    return patch
  }

  // 表单打开时读到的基线, 加上用户在表单里改的字段
  const submissionFor = async (
    uniqueId: string,
    changes: {
      name?: string
      alias?: string[]
      removeTagIds?: number[]
      addTagNames?: string[]
    } = {}
  ) => {
    const initial = (await getGalgameForRewrite(uniqueId))!
    return {
      id: initial.id,
      name: initial.name,
      ...initial.externalIds,
      dlsiteCircleName: '',
      dlsiteCircleLink: '',
      vndbTags: [],
      vndbDevelopers: [],
      bangumiTags: [],
      bangumiDevelopers: [],
      steamTags: [],
      steamDevelopers: [],
      dlsiteTags: [],
      introduction: initial.introduction,
      alias: initial.alias,
      contentLimit: initial.contentLimit,
      released: initial.released,
      removeTagIds: [],
      addTagNames: [],
      baseFingerprint: initial.baseFingerprint,
      ...changes
    }
  }

  const stored = async (id: number) => {
    const patch = await prisma.patch.findUniqueOrThrow({
      where: { id },
      select: {
        name: true,
        alias: { select: { name: true }, orderBy: { id: 'asc' } },
        tag: {
          select: { tag: { select: { name: true } } },
          orderBy: { id: 'asc' }
        }
      }
    })
    return {
      name: patch.name,
      alias: patch.alias.map((alias) => alias.name),
      tags: patch.tag.map((relation) => relation.tag.name)
    }
  }

  const outboxRow = (patchId: number) =>
    prisma.search_outbox.findUnique({ where: { patch_id: patchId } })

  it('基线仍是库里的值: 字段、别名 (含顺序)、标签差量与搜索出箱都落库', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    const tag = `t14-${randomUUID().slice(0, 8)}`

    const result = await updateGalgame(
      await submissionFor(patch.unique_id, {
        name: '改之后的名字',
        alias: ['乙', '甲', '丙'],
        addTagNames: [tag]
      }),
      user.id
    )

    expect(result).toEqual({})
    expect(await stored(patch.id)).toEqual({
      name: '改之后的名字',
      alias: ['乙', '甲', '丙'],
      tags: [tag]
    })
    expect(await outboxRow(patch.id)).not.toBeNull()
    // 保存之后再读基线, 别名按保存时的顺序读回
    expect((await getGalgameForRewrite(patch.unique_id))?.alias).toEqual([
      '乙',
      '甲',
      '丙'
    ])
  })

  it('表单打开之后别人改过名字: 返回冲突提示, 字段、别名、出箱都没写', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    const stale = await submissionFor(patch.unique_id, {
      name: '我想改成的名字',
      alias: ['我想改成的别名']
    })
    await prisma.patch.update({
      where: { id: patch.id },
      data: { name: '别人改过的名字' }
    })

    const result = await updateGalgame(stale, user.id)

    expect(result).toBe(CONFLICT)
    expect(await stored(patch.id)).toEqual({
      name: '别人改过的名字',
      alias: ['原别名'],
      tags: []
    })
    expect(await outboxRow(patch.id)).toBeNull()
  })

  it('表单打开之后别人换过别名: 同样判冲突', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    const stale = await submissionFor(patch.unique_id, { name: '我的名字' })
    expect(
      await updateGalgame(
        await submissionFor(patch.unique_id, { alias: ['别人的别名'] }),
        user.id
      )
    ).toEqual({})

    expect(await updateGalgame(stale, user.id)).toBe(CONFLICT)
    expect(await stored(patch.id)).toMatchObject({
      name: '改之前的名字',
      alias: ['别人的别名']
    })
  })

  // patch.updated 会被这类写入推进, 所以令牌不能用它
  it('期间只有无关写入 (下载计数): 不算冲突', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    const submission = await submissionFor(patch.unique_id, {
      name: '改之后的名字'
    })
    await prisma.patch.update({
      where: { id: patch.id },
      data: { download: { increment: 1 }, view: { increment: 7 } }
    })

    expect(await updateGalgame(submission, user.id)).toEqual({})
    expect((await stored(patch.id)).name).toBe('改之后的名字')
  })

  it('刷新后带着新基线再提交: 通过', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    const stale = await submissionFor(patch.unique_id, { name: '我的名字' })
    await prisma.patch.update({
      where: { id: patch.id },
      data: { name: '别人改过的名字' }
    })
    expect(await updateGalgame(stale, user.id)).toBe(CONFLICT)

    const refreshed = await submissionFor(patch.unique_id, { name: '我的名字' })

    expect(await updateGalgame(refreshed, user.id)).toEqual({})
    expect((await stored(patch.id)).name).toBe('我的名字')
  })

  it('主事务已提交、标签步骤失败之后原样重试: 放行, 标签补上', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    const tag = `t14-${randomUUID().slice(0, 8)}`
    const submission = await submissionFor(patch.unique_id, {
      name: '改之后的名字',
      alias: ['新别名'],
      addTagNames: [tag]
    })

    tagStep.failNext = true
    await expect(updateGalgame(submission, user.id)).rejects.toThrow(
      'tag step failed'
    )
    // 字段与别名已经落库, 标签没写: 这时库里的值不再是提交带来的基线
    expect(await stored(patch.id)).toEqual({
      name: '改之后的名字',
      alias: ['新别名'],
      tags: []
    })

    expect(await updateGalgame(submission, user.id)).toEqual({})
    expect(await stored(patch.id)).toEqual({
      name: '改之后的名字',
      alias: ['新别名'],
      tags: [tag]
    })
  })

  it('别名写入失败时字段更新一起回滚', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    // 绕过路由的校验: 超出 patch_alias.name 的 VarChar(1007)
    const submission = await submissionFor(patch.unique_id, {
      name: '改之后的名字',
      alias: ['新别名', 'x'.repeat(1008)]
    })

    await expect(updateGalgame(submission, user.id)).rejects.toThrow()

    expect(await stored(patch.id)).toEqual({
      name: '改之前的名字',
      alias: ['原别名'],
      tags: []
    })
    expect(await outboxRow(patch.id)).toBeNull()
  })

  // 另一条连接先占住 patch 行: 两次提交都停在行锁上 (去掉行锁的话, 两边都会先读到同一份
  // 当前值、各自通过比较)。放开之后先拿到锁的写入, 后一个在锁下读到的已是对方的值
  it('同一基线的两次并发提交: 恰好一个成功, 库里是它的字段与别名', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    const submissions = [
      await submissionFor(patch.unique_id, { name: '甲的名字', alias: ['甲'] }),
      await submissionFor(patch.unique_id, { name: '乙的名字', alias: ['乙'] })
    ]
    const blocker = new pg.Client({ connectionString: dbContractUrl })
    await blocker.connect()
    let results: Awaited<ReturnType<typeof updateGalgame>>[]
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        'SELECT id FROM patch WHERE id = $1 FOR NO KEY UPDATE',
        [patch.id]
      )
      const pending = Promise.all(
        submissions.map((submission) => updateGalgame(submission, user.id))
      )
      await sleep(300)
      await blocker.query('COMMIT')
      results = await pending
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await blocker.end()
    }

    expect(results.filter((result) => result === CONFLICT)).toHaveLength(1)
    const winner =
      submissions[results.findIndex((result) => result !== CONFLICT)]
    expect(results.find((result) => result !== CONFLICT)).toEqual({})
    expect(await stored(patch.id)).toMatchObject({
      name: winner.name,
      alias: winner.alias
    })
  })

  // 外部 ID 是唯一索引列, 改到它们的 UPDATE 要取 FOR UPDATE 级的行锁。事务若先拿较弱的
  // FOR NO KEY UPDATE、读完再升级, 夹在中间经外键取到 FOR KEY SHARE 的子表插入 (回复评论、
  // 发资源、收藏) 接着要等我们才能更新计数, 我们升级锁又要等它: 互等, 一方 40P01
  it('改外部 ID 的提交与同一条目上的子表插入交错: 双方都成功, 不互等', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    const submission = {
      ...(await submissionFor(patch.unique_id)),
      bangumiId: '424242'
    }
    const gate = new pg.Client({ connectionString: dbContractUrl })
    const child = new pg.Client({ connectionString: dbContractUrl })
    await gate.connect()
    await child.connect()
    try {
      // 闸门占住 patch_alias: 提交拿到 patch 行锁之后读别名时停在这里, 正好卡在
      // 「已持行锁、还没执行 UPDATE」之间
      await gate.query('BEGIN')
      await gate.query('LOCK TABLE patch_alias IN ACCESS EXCLUSIVE MODE')
      const pending = updateGalgame(submission, user.id)
      await sleep(300)

      // 子表插入对 patch 行做的两件事: 外键检查取 FOR KEY SHARE, 计数触发器再 UPDATE 它
      await child.query('BEGIN')
      const childDone = child
        .query('SELECT id FROM patch WHERE id = $1 FOR KEY SHARE', [patch.id])
        .then(() =>
          child.query(
            'UPDATE patch SET download = download + 1 WHERE id = $1',
            [patch.id]
          )
        )
        .then(() => child.query('COMMIT'))
      await sleep(300)
      await gate.query('COMMIT')

      const [result] = await Promise.all([pending, childDone])
      expect(result).toEqual({})
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined)
      await child.query('ROLLBACK').catch(() => undefined)
      await gate.end()
      await child.end()
    }

    expect(
      await prisma.patch.findUniqueOrThrow({
        where: { id: patch.id },
        select: { bangumi_id: true, download: true }
      })
    ).toEqual({ bangumi_id: 424242, download: 1 })
  })
})
