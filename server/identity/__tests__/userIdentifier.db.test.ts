import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'
import { kunViolationCodeOf } from '~/server/db/violations'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'

// 用户名与邮箱「只差大小写」的唯一性在真实 PostgreSQL 上的行为 (运行方式见
// server/db/__tests__/dbContract.ts)。注册与改名先用 insensitiveEquals 编译出的 ILIKE 预检,
// 预检与写入之间的并发窗口由迁移 0018 的 lower(name) / lower(email) 表达式唯一索引兜住。
// 两者必须判同一组「同名」: 预检比索引严 (预检命中、索引放行) 只是多拦一些, 是安全的;
// 索引比预检严 (预检放行、索引拒绝) 时请求在写入处拿到 P2002, 由写入方的 catch 或 kunRoute
// 翻成冲突文案, 也写不出重复, 但用户看到的不再是预检那句可读的提示。下面的探针在
// postgres:17-alpine (en_US.utf8, libc) 上两个方向都没有出现: UTF8 库上 ILIKE 的实现就是两侧
// 先 lower() 再做 LIKE, 转义掉通配符之后与 lower() = lower() 是同一个判定。换排序规则
// (ICU、C) 之后哪些字符折叠会变, 但两侧仍用同一个 lower(), 这里比的是两侧是否一致

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
  // 不转义时 _ 与 % 是通配符, 会命中 abc 与其余三行
  'a_c',
  'A_C',
  'a%c',
  'A%C',
  '_',
  '%',
  // 反斜杠是 LIKE 的默认转义符
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
        // 邮箱形态的用户名, 而这个邮箱没有人注册
        lonely: await createUser('lonely@qq.com', 'lonely-real@qq.com')
      })

      it('邮箱形态的输入取邮箱持有者, 没有持有者才回落到 name 列', async () => {
        const { owner, lonely } = await seedAccounts()

        expect(
          await lookup.findUserForLogin({ kind: 'email', raw: 'VICTIM@qq.com' })
        ).toMatchObject({ id: owner.id })
        expect(
          await lookup.findUserForLogin({ kind: 'email', raw: 'Lonely@QQ.com' })
        ).toMatchObject({ id: lonely.id })
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
    })

    describe('预检的 ILIKE 与 lower() 索引判同一组同名', () => {
      const seed = async () => {
        const rows = new Map<number, string>()
        for (const name of STORED) {
          rows.set((await createUser(name, emailOf(name))).id, name)
        }
        return rows
      }

      const namesOf = (rows: Map<number, string>, ids: { id: number }[]) =>
        ids.map(({ id }) => rows.get(id)).sort()

      it('逐个探针: 预检命中的行与 lower(列) = lower(探针) 命中的行相同', async () => {
        const rows = await seed()
        const mismatches: unknown[] = []
        let matched = 0

        for (const probe of PROBES) {
          const byName = {
            precheck: namesOf(
              rows,
              await prisma.user.findMany({
                where: { name: lookup.insensitiveEquals(probe) },
                select: { id: true }
              })
            ),
            lower: namesOf(
              rows,
              await prisma.$queryRaw<{ id: number }[]>`
                SELECT id FROM "user" WHERE lower(name) = lower(${probe}::text)
              `
            )
          }
          const byEmail = {
            precheck: namesOf(
              rows,
              await prisma.user.findMany({
                where: { email: lookup.insensitiveEquals(emailOf(probe)) },
                select: { id: true }
              })
            ),
            lower: namesOf(
              rows,
              await prisma.$queryRaw<{ id: number }[]>`
                SELECT id FROM "user" WHERE lower(email) = lower(${emailOf(probe)}::text)
              `
            )
          }
          for (const [column, result] of Object.entries({ byName, byEmail })) {
            if (
              JSON.stringify(result.precheck) !== JSON.stringify(result.lower)
            ) {
              mismatches.push({ probe, column, ...result })
            }
          }
          matched += byName.lower.length
        }

        expect(mismatches).toEqual([])
        // 两侧不是恒为空: 9 个纯 ASCII 的探针在任何排序规则下都折叠得到 (C 也一样);
        // 非 ASCII 的命中数随排序规则变化, 不在这里定死
        expect(matched).toBeGreaterThanOrEqual(9)
      })

      it('负对照: 不转义通配符时两侧不一致, 上面的比对能发现差异', async () => {
        const rows = await seed()

        const unescaped = namesOf(
          rows,
          await prisma.user.findMany({
            where: { name: { equals: 'a_c', mode: 'insensitive' } },
            select: { id: true }
          })
        )

        expect(unescaped).toEqual(['a%c', 'a\\c', 'a_c', 'abc'])
        expect(
          namesOf(
            rows,
            await prisma.user.findMany({
              where: { name: lookup.insensitiveEquals('a_c') },
              select: { id: true }
            })
          )
        ).toEqual(['a_c'])
      })

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
