import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'
import { kunViolationCodeOf } from '~/server/db/violations'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'

// 用户名与邮箱「只差大小写」的唯一性在真实 PostgreSQL 上的行为 (运行方式见
// server/db/__tests__/dbContract.ts)。注册与改名先经 server/identity/lookup.ts 预检
// (lower(列) = lower(输入)), 预检与写入之间的并发窗口由迁移 0018 的 lower(name) /
// lower(email) 表达式唯一索引兜住。两者必须判同一组「同名」: 预检比索引严 (预检命中、索引
// 放行) 只是多拦一些, 是安全的; 索引比预检严 (预检放行、索引拒绝) 时请求在写入处拿到
// P2002, 由写入方的 catch 或 kunRoute 翻成冲突文案, 也写不出重复, 但用户看到的不再是预检
// 那句可读的提示。两侧用的是同一个库内 lower(), 下面的探针逐个核对; 换排序规则 (ICU、C)
// 之后哪些字符折叠会变, 但两侧仍一致。预检的语句还必须真的走这条索引 (见「走 lower()
// 唯一索引」那一例): 不走就是每次登录、查重都顺扫全表

const INDEXES = ['user_email_lower_key', 'user_name_lower_key']

// 库里存的名字两两之间 lower() 不同 (否则建不进去); 探针里有它们的大小写变体、通配符与
// 几类大小写映射特殊的字符。名字列是 varchar(17)
const STORED = [
  'KunGal',
  'abc',
  'a_c',
  'a%c',
  'a\\c',
  'Émile',
  'Straße',
  'Дмитрий',
  'ＡＢＣ',
  'İstanbul',
  'ΟΔΟΣ'
]
const PROBES = [
  'kungal',
  'KUNGAL',
  // _ 与 % 在 LIKE / ILIKE 里是通配符 (会命中 abc 与其余三行), 在等号比较里是字面
  'a_c',
  'A_C',
  'a%c',
  'A%C',
  '_',
  '%',
  // 反斜杠是 LIKE 的默认转义符, 在等号比较里同样是字面
  'a\\c',
  'A\\C',
  'émile',
  'ÉMILE',
  // ß 的大写在 lower() 里不会还原成 ß: STRASSE 与 Straße 不算同名; ẞ (U+1E9E) 会
  'STRASSE',
  'straße',
  'STRAẞE',
  'дмитрий',
  'ДМИТРИЙ',
  'ａｂｃ',
  'abc',
  // libc 把 İ (U+0130) 折成 i: istanbul / ISTANBUL 都与 İstanbul 同名; 无点的 ı 不是
  'istanbul',
  'ISTANBUL',
  'İSTANBUL',
  'ıstanbul',
  // 逐字符映射, 不做词尾 σ → ς 的处理: 只有 οδοσ 与 ΟΔΟΣ 同名
  'οδος',
  'οδοσ',
  'ΟΔΟΣ'
]

const emailOf = (local: string) => `${local}@example.com`

describe.skipIf(!dbContractUrl)(
  'case-insensitive user identifiers on real PostgreSQL',
  () => {
    let prisma: Awaited<ReturnType<typeof openDbContract>>
    let lookup: typeof import('~/server/identity/lookup')
    let createdUserIds: number[] = []

    beforeAll(async () => {
      prisma = await openDbContract()
      lookup = await import('~/server/identity/lookup')
    })

    afterEach(async () => {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
      createdUserIds = []
    })

    afterAll(async () => {
      await prisma?.$disconnect()
    })

    const createUser = async (
      name: string,
      email = emailOf(randomUUID()),
      moemoepoint = 0
    ) => {
      const user = await prisma.user.create({
        data: { name, email, password: 'x', moemoepoint }
      })
      createdUserIds.push(user.id)
      return user
    }

    const errorOf = (write: Promise<unknown>) =>
      write.then(
        () => undefined,
        (error: unknown) => error
      )

    const expectUniqueViolation = (error: unknown) => {
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002')
      expect(kunViolationCodeOf(error)).toBe('P2002')
    }

    // app/api/user/setting/username/route.ts 里改名的那条条件更新, 原样照抄
    const renameWithCharge = (id: number, username: string) =>
      prisma.user.updateMany({
        where: { id, moemoepoint: { gte: 30 }, name: { not: username } },
        data: { name: username, moemoepoint: { increment: -30 } }
      })

    it('两个表达式唯一索引都已建成且有效 (迁移回放过)', async () => {
      const rows = await prisma.$queryRaw<
        { name: string; indisunique: boolean; indisvalid: boolean }[]
      >`
        SELECT c.relname AS name, i.indisunique, i.indisvalid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname IN (${Prisma.join(INDEXES)})
        ORDER BY c.relname
      `
      expect(rows).toEqual(
        INDEXES.map((name) => ({ name, indisunique: true, indisvalid: true }))
      )
    })

    describe('只差大小写的写入被挡下', () => {
      it('新建用户: 用户名只差大小写 → P2002', async () => {
        await createUser('Kun')
        expectUniqueViolation(await errorOf(createUser('kUN')))
      })

      it('新建用户: 邮箱只差大小写 → P2002', async () => {
        await createUser('first', 'Kun.Mail@Example.com')
        expectUniqueViolation(
          await errorOf(createUser('second', 'kun.mail@example.COM'))
        )
      })

      it('把别人的名字改成大小写变体 → P2002, 改名的条件更新整条回滚、不扣分', async () => {
        await createUser('kun')
        const other = await createUser('other', undefined, 30)

        expectUniqueViolation(
          await errorOf(
            prisma.user.update({
              where: { id: other.id },
              data: { name: 'Kun' }
            })
          )
        )
        expectUniqueViolation(await errorOf(renameWithCharge(other.id, 'KUN')))
        expect(
          await prisma.user.findUniqueOrThrow({
            where: { id: other.id },
            select: { name: true, moemoepoint: true }
          })
        ).toEqual({ name: 'other', moemoepoint: 30 })
      })

      it('把别人的邮箱改成大小写变体 → P2002', async () => {
        await createUser('first', 'owner@example.com')
        const other = await createUser('second')

        expectUniqueViolation(
          await errorOf(
            prisma.user.updateMany({
              where: { id: other.id },
              data: { email: 'Owner@Example.com' }
            })
          )
        )
      })
    })

    it('改自己名字的大小写 (Kun → KUN) 不撞索引: 改名的条件更新命中 1 行并扣分', async () => {
      const user = await createUser('Kun', undefined, 30)

      const { count } = await renameWithCharge(user.id, 'KUN')

      expect(count).toBe(1)
      expect(
        await prisma.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { name: true, moemoepoint: true }
        })
      ).toEqual({ name: 'KUN', moemoepoint: 0 })
    })

    // server/identity/lookup.ts 编译出的查询在真库上的结果 (路由测试里的分流是 mock)
    describe('按种类找人与排除自身', () => {
      const seedAccounts = async () => ({
        owner: await createUser('victim', 'Victim@QQ.com'),
        // 把用户名改成了别人邮箱的账号 (改名规则收紧之前的存量): 与 owner 不在同一列, 不撞索引
        squatter: await createUser('victim@qq.com', 'attacker@qq.com'),
        // 邮箱形态的用户名, 而这个邮箱没有人注册 (生产统计为 0 的那类存量)
        lonely: await createUser('lonely@qq.com', 'lonely-real@qq.com')
      })

      it('邮箱形态的输入取邮箱持有者, 没有持有者时不回落到 name 列', async () => {
        const { owner } = await seedAccounts()

        expect(
          await lookup.findUserForLogin({ kind: 'email', raw: 'VICTIM@qq.com' })
        ).toMatchObject({ id: owner.id })
        expect(
          await lookup.findUserForLogin({ kind: 'email', raw: 'Lonely@QQ.com' })
        ).toBeNull()
        expect(
          await lookup.findUserForLogin({ kind: 'email', raw: 'nobody@qq.com' })
        ).toBeNull()
      })

      it('用户名形态的输入只按 name 列匹配, 通配符按字面', async () => {
        const { owner } = await seedAccounts()

        expect(
          await lookup.findUserForLogin({ kind: 'name', raw: 'VICTIM' })
        ).toMatchObject({ id: owner.id })
        expect(
          await lookup.findUserForLogin({ kind: 'name', raw: 'vict_m' })
        ).toBeNull()
        // attacker@qq.com 是 squatter 的邮箱; 用户名形态的输入不查 email 列
        expect(
          await lookup.findUserForLogin({ kind: 'name', raw: 'attacker' })
        ).toBeNull()
      })

      it('找回密码按邮箱大小写不敏感地找人, 只回 id 与库里存的邮箱', async () => {
        const { owner } = await seedAccounts()

        expect(await lookup.findUserByEmailForReset('victim@qq.COM')).toEqual({
          id: owner.id,
          email: 'Victim@QQ.com'
        })
      })

      it('查重排除给定的 uid: 改自己名字或邮箱的大小写不算被占用', async () => {
        const { owner, squatter } = await seedAccounts()

        expect(
          await lookup.isUsernameTaken('VICTIM', { exceptUid: null })
        ).toBe(true)
        expect(
          await lookup.isUsernameTaken('VICTIM', { exceptUid: owner.id })
        ).toBe(false)
        expect(
          await lookup.isUsernameTaken('VICTIM', { exceptUid: squatter.id })
        ).toBe(true)
        expect(
          await lookup.isEmailTaken('victim@qq.com', { exceptUid: owner.id })
        ).toBe(false)
        expect(
          await lookup.isEmailTaken('victim@qq.com', { exceptUid: squatter.id })
        ).toBe(true)
      })

      // 小表上顺扫更便宜, 所以关掉顺扫, 看的是「能不能」走索引: 写成 Prisma 的
      // { equals, mode: 'insensitive' } (ILIKE) 或与索引表达式对不上的 lower() 时这一例变红
      it('找人与查重的语句走 lower() 唯一索引', async () => {
        const plans = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL enable_seqscan = off`
          const explain = async (sql: Prisma.Sql) =>
            (
              await tx.$queryRaw<{ 'QUERY PLAN': string }[]>(
                Prisma.sql`EXPLAIN ${sql}`
              )
            )
              .map((row) => row['QUERY PLAN'])
              .join('\n')
          return {
            name: await explain(lookup.userIdByLowerSql('name', 'Kun', null)),
            email: await explain(
              lookup.userIdByLowerSql('email', 'Kun@QQ.com', 7)
            ),
            // 负对照: ILIKE 用不上 btree 索引, 关了顺扫也只能顺扫
            ilike: await explain(
              Prisma.sql`SELECT id FROM "user" WHERE name ILIKE ${'Kun'} LIMIT 1`
            )
          }
        })

        const usesIndex = (index: string) =>
          new RegExp(
            `(Index (Only )?Scan using|Bitmap Index Scan on) ${index}\\b`
          )
        expect(plans.name).toMatch(usesIndex('user_name_lower_key'))
        expect(plans.email).toMatch(usesIndex('user_email_lower_key'))
        expect(plans.ilike).not.toMatch(usesIndex('user_name_lower_key'))
        expect(plans.ilike).toMatch(/Seq Scan on "?user"?/)
      })
    })

    describe('预检与 lower() 索引判同一组同名', () => {
      const seed = async () => {
        const rows = new Map<number, string>()
        for (const name of STORED) {
          rows.set((await createUser(name, emailOf(name))).id, name)
        }
        return rows
      }

      it('逐个探针: 预检判为已占用, 当且仅当写入撞上唯一索引', async () => {
        await seed()
        const mismatches: unknown[] = []

        for (const probe of PROBES) {
          const nameTaken = await lookup.isUsernameTaken(probe, {
            exceptUid: null
          })
          const nameError = await errorOf(createUser(probe))
          const emailTaken = await lookup.isEmailTaken(emailOf(probe), {
            exceptUid: null
          })
          const emailError = await errorOf(
            createUser(randomUUID().slice(0, 17), emailOf(probe))
          )

          // 意外写进去的行由 createUser 登记、afterEach 删掉; 这里先删, 免得影响后面的探针
          await prisma.user.deleteMany({
            where: {
              id: { in: createdUserIds.slice(STORED.length) }
            }
          })
          createdUserIds = createdUserIds.slice(0, STORED.length)

          for (const [column, taken, error] of [
            ['name', nameTaken, nameError],
            ['email', emailTaken, emailError]
          ] as const) {
            const rejected = kunViolationCodeOf(error) === 'P2002'
            if (taken !== rejected || (error !== undefined && !rejected)) {
              mismatches.push({ probe, column, taken, error: String(error) })
            }
          }
        }

        expect(mismatches).toEqual([])
      })
    })
  }
)
