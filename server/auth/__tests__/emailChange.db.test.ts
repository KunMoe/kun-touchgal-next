import { randomUUID } from 'crypto'
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
import type { StepUpPassed } from '~/server/auth/stepUp'

// 邮箱变更台账在真实 PostgreSQL 上的行为 (运行方式见 server/db/__tests__/dbContract.ts)。
// 条件更新靠行锁之后由库重新判定、冷却靠同一把行锁下的查询: 这两件事 mock 测不出来

const HOUR_MS = 60 * 60 * 1000

describe.skipIf(!dbContractUrl)(
  'email change ledger on real PostgreSQL',
  () => {
    let prisma: Awaited<ReturnType<typeof openDbContract>>
    let emailChange: typeof import('~/server/auth/emailChange')
    let backupCodes: typeof import('~/server/auth/twoFactorBackupCode')
    let createdUserIds: number[] = []

    beforeAll(async () => {
      vi.stubEnv(
        'KUN_TWO_FACTOR_BACKUP_PEPPER',
        'test-only-two-factor-backup-pepper-1234567890'
      )
      prisma = await openDbContract()
      emailChange = await import('~/server/auth/emailChange')
      backupCodes = await import('~/server/auth/twoFactorBackupCode')
    })

    afterEach(async () => {
      // 台账行随用户级联删除
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
      createdUserIds = []
    })

    afterAll(async () => {
      await prisma?.$disconnect()
      vi.unstubAllEnvs()
    })

    const address = (label: string) => `${label}-${randomUUID()}@example.com`

    const newUser = async (email = address('a')) => {
      const user = await prisma.user.create({
        data: { name: randomUUID().slice(0, 17), email, password: 'x' }
      })
      createdUserIds.push(user.id)
      return user
    }

    // 品牌值只有 requireStepUp 造得出来; 这里测的是它之后的那一步
    const passed = (uid: number) =>
      ({ uid, action: 'email.change' }) as StepUpPassed<'email.change'>

    const change = async (uid: number, oldEmail: string, newEmail: string) => {
      const revert = emailChange.issueRevertToken()
      const failure = await emailChange.commitEmailChange(passed(uid), {
        oldEmail,
        newEmail,
        revertTokenHash: revert.hash
      })
      return { failure, token: revert.token }
    }

    const emailOf = async (uid: number) =>
      (await prisma.user.findUniqueOrThrow({ where: { id: uid } })).email

    const ledgerOf = (uid: number) =>
      prisma.user_email_change.findMany({
        where: { user_id: uid },
        orderBy: { id: 'asc' }
      })

    // 把已有的台账行整体往前挪, 等于让时间过去了这么久
    const age = (uid: number, hours: number) =>
      prisma.$executeRaw`
      UPDATE user_email_change
      SET created = created - make_interval(hours => ${hours}),
          expires = expires - make_interval(hours => ${hours})
      WHERE user_id = ${uid}
    `

    describe('changing', () => {
      it('switches the email and records the change with a 24-hour revert window', async () => {
        const user = await newUser()
        const next = address('b')
        const before = Date.now()

        const { failure, token } = await change(user.id, user.email, next)

        expect(failure).toBeUndefined()
        expect(await emailOf(user.id)).toBe(next)
        const [row] = await ledgerOf(user.id)
        expect(row).toMatchObject({
          old_email: user.email,
          new_email: next,
          reverted: null
        })
        // 库里只有令牌的哈希
        expect(row.revert_token_hash).toMatch(/^[0-9a-f]{64}$/)
        expect(row.revert_token_hash).not.toBe(token)
        // JS Date 写进无时区列再读回来是同一个时刻, 与库的会话时区无关
        expect(row.created.getTime()).toBeGreaterThanOrEqual(before - 5)
        expect(row.created.getTime()).toBeLessThanOrEqual(Date.now() + 5)
        expect(row.expires.getTime() - row.created.getTime()).toBe(24 * HOUR_MS)
      })

      // P07-01 / X07-01: 入侵者把邮箱从 A 改到 B 再改到 C, 发往 A 的撤销链接曾就此作废
      it('refuses a second change within 24 hours, so the first revert link keeps working', async () => {
        const user = await newUser()
        const b = address('b')
        const c = address('c')
        const first = await change(user.id, user.email, b)

        const second = await change(user.id, b, c)

        expect(second.failure).toBe(emailChange.EMAIL_CHANGE_COOLDOWN_MESSAGE)
        expect(await emailOf(user.id)).toBe(b)
        expect(await ledgerOf(user.id)).toHaveLength(1)

        await expect(
          emailChange.revertEmailChange(first.token)
        ).resolves.toEqual({
          status: 'reverted',
          uid: user.id,
          oldEmail: user.email
        })
        expect(await emailOf(user.id)).toBe(user.email)
      })

      it('counts a reverted change towards the cooldown', async () => {
        const user = await newUser()
        const first = await change(user.id, user.email, address('b'))
        await emailChange.revertEmailChange(first.token)

        const again = await change(user.id, user.email, address('c'))

        expect(again.failure).toBe(emailChange.EMAIL_CHANGE_COOLDOWN_MESSAGE)
        expect(await emailOf(user.id)).toBe(user.email)
        await expect(
          emailChange.isEmailChangeCoolingDown(user.id)
        ).resolves.toBe(true)
      })

      it('allows the next change once 24 hours have passed', async () => {
        const user = await newUser()
        const b = address('b')
        const c = address('c')
        await change(user.id, user.email, b)

        await age(user.id, 23)
        await expect(
          emailChange.isEmailChangeCoolingDown(user.id)
        ).resolves.toBe(true)
        expect((await change(user.id, b, c)).failure).toBe(
          emailChange.EMAIL_CHANGE_COOLDOWN_MESSAGE
        )

        await age(user.id, 2)
        await expect(
          emailChange.isEmailChangeCoolingDown(user.id)
        ).resolves.toBe(false)
        expect((await change(user.id, b, c)).failure).toBeUndefined()
        expect(await emailOf(user.id)).toBe(c)
        expect(await ledgerOf(user.id)).toHaveLength(2)
      })

      it('does nothing when the account email is no longer the one the request started from', async () => {
        const user = await newUser()

        const { failure } = await change(
          user.id,
          address('stale'),
          address('b')
        )

        expect(failure).toBe('账户邮箱已发生变化, 请刷新后重试')
        expect(await emailOf(user.id)).toBe(user.email)
        expect(await ledgerOf(user.id)).toEqual([])
      })

      it('lets exactly one of two concurrent changes through', async () => {
        for (let round = 0; round < 5; round++) {
          const user = await newUser()
          const targets = [address('b'), address('c'), address('d')]

          const results = await Promise.all(
            targets.map((target) => change(user.id, user.email, target))
          )

          const winners = results.filter((result) => !result.failure)
          expect(winners).toHaveLength(1)
          const ledger = await ledgerOf(user.id)
          expect(ledger).toHaveLength(1)
          expect(await emailOf(user.id)).toBe(ledger[0].new_email)
          // 落败的请求没有留下任何东西: 邮箱没被它改, 台账里也没有它的行
          for (const loser of results.filter((result) => result.failure)) {
            expect([
              '账户邮箱已发生变化, 请刷新后重试',
              emailChange.EMAIL_CHANGE_COOLDOWN_MESSAGE
            ]).toContain(loser.failure)
          }
        }
      })

      it('throws on an address taken by another account and leaves no ledger row', async () => {
        const user = await newUser()
        const other = await newUser()

        await expect(
          change(user.id, user.email, other.email)
        ).rejects.toMatchObject({ code: 'P2002' })

        expect(await emailOf(user.id)).toBe(user.email)
        expect(await ledgerOf(user.id)).toEqual([])
      })

      // 用备份码通过二次验证的: 备份码在提交的那个事务里消费, 提交没成它就还在
      describe('with a backup code as the second factor', () => {
        const CODES = ['0123456789', '654321']

        const newUserWith2FA = async () => {
          const user = await newUser()
          await prisma.user.update({
            where: { id: user.id },
            data: {
              enable_2fa: true,
              two_factor_backup: CODES.map(backupCodes.hashTwoFactorBackupCode)
            }
          })
          return user
        }

        const changeWith = (
          uid: number,
          oldEmail: string,
          backupCode: string
        ) =>
          emailChange.commitEmailChange(
            { ...passed(uid), backupCode },
            {
              oldEmail,
              newEmail: address('b'),
              revertTokenHash: emailChange.issueRevertToken().hash
            }
          )

        const storedCodes = async (uid: number) =>
          (await prisma.user.findUniqueOrThrow({ where: { id: uid } }))
            .two_factor_backup

        it('uses the code up together with the change', async () => {
          const user = await newUserWith2FA()

          await expect(
            changeWith(user.id, user.email, CODES[0])
          ).resolves.toBeUndefined()

          expect(await emailOf(user.id)).not.toBe(user.email)
          expect(await storedCodes(user.id)).toEqual([
            backupCodes.hashTwoFactorBackupCode(CODES[1])
          ])
        })

        it('keeps the code when the change is refused', async () => {
          const user = await newUserWith2FA()
          const first = await change(user.id, user.email, address('b'))
          expect(first.failure).toBeUndefined()

          await expect(
            changeWith(user.id, await emailOf(user.id), CODES[0])
          ).resolves.toBe(emailChange.EMAIL_CHANGE_COOLDOWN_MESSAGE)

          expect(await storedCodes(user.id)).toHaveLength(2)
        })

        it('undoes the change when the code is no longer on file', async () => {
          const user = await newUserWith2FA()

          await expect(
            changeWith(user.id, user.email, '9999999999')
          ).resolves.toBe('2FA 验证码无效')

          expect(await emailOf(user.id)).toBe(user.email)
          expect(await ledgerOf(user.id)).toEqual([])
          expect(await storedCodes(user.id)).toHaveLength(2)
        })

        it('lets only one of two concurrent changes spend the same code', async () => {
          const user = await newUserWith2FA()

          const results = await Promise.all([
            changeWith(user.id, user.email, CODES[0]),
            changeWith(user.id, user.email, CODES[0])
          ])

          expect(results.filter((result) => !result)).toHaveLength(1)
          expect(await storedCodes(user.id)).toHaveLength(1)
          expect(await ledgerOf(user.id)).toHaveLength(1)
        })
      })

      it('drops the ledger rows together with the user', async () => {
        const user = await newUser()
        await change(user.id, user.email, address('b'))

        await prisma.user.delete({ where: { id: user.id } })

        expect(await ledgerOf(user.id)).toEqual([])
      })
    })

    describe('reverting', () => {
      it('shows the old address for a valid token only', async () => {
        const user = await newUser()
        const { token } = await change(user.id, user.email, address('b'))

        await expect(
          emailChange.findRevertibleEmailChange(token)
        ).resolves.toEqual({ oldEmail: user.email })
        await expect(
          emailChange.findRevertibleEmailChange(randomUUID())
        ).resolves.toBeNull()
      })

      it('restores the old address once, also under concurrent submissions', async () => {
        const user = await newUser()
        const { token } = await change(user.id, user.email, address('b'))

        const results = await Promise.all(
          Array.from({ length: 6 }, () => emailChange.revertEmailChange(token))
        )

        expect(
          results.filter((result) => result.status === 'reverted')
        ).toHaveLength(1)
        expect(
          results.filter((result) => result.status === 'not-found')
        ).toHaveLength(5)
        expect(await emailOf(user.id)).toBe(user.email)
        const [row] = await ledgerOf(user.id)
        expect(row.reverted).toBeInstanceOf(Date)
        await expect(
          emailChange.findRevertibleEmailChange(token)
        ).resolves.toBeNull()
      })

      it('refuses an unknown token and one past its 24 hours', async () => {
        const user = await newUser()
        const next = address('b')
        const { token } = await change(user.id, user.email, next)

        await expect(
          emailChange.revertEmailChange(randomUUID())
        ).resolves.toEqual({ status: 'not-found' })

        await age(user.id, 25)
        await expect(emailChange.revertEmailChange(token)).resolves.toEqual({
          status: 'not-found'
        })
        expect(await emailOf(user.id)).toBe(next)
      })

      // 冷却期内用户自己改不了第二次, 邮箱对不上只可能是管理员在后台改过
      it('leaves an email changed by an admin alone, and keeps the token usable', async () => {
        const user = await newUser()
        const next = address('b')
        const byAdmin = address('admin')
        const { token } = await change(user.id, user.email, next)
        await prisma.user.update({
          where: { id: user.id },
          data: { email: byAdmin }
        })

        await expect(emailChange.revertEmailChange(token)).resolves.toEqual({
          status: 'superseded'
        })
        expect(await emailOf(user.id)).toBe(byAdmin)
        expect((await ledgerOf(user.id))[0].reverted).toBeNull()

        // 管理员把邮箱改回这次变更后的值: 链接仍然有效
        await prisma.user.update({
          where: { id: user.id },
          data: { email: next }
        })
        await expect(
          emailChange.revertEmailChange(token)
        ).resolves.toMatchObject({ status: 'reverted' })
        expect(await emailOf(user.id)).toBe(user.email)
      })

      it('throws when the old address now belongs to another account, without using the token up', async () => {
        const user = await newUser()
        const next = address('b')
        const { token } = await change(user.id, user.email, next)
        await newUser(user.email)

        await expect(
          emailChange.revertEmailChange(token)
        ).rejects.toMatchObject({ code: 'P2002' })

        expect(await emailOf(user.id)).toBe(next)
        expect((await ledgerOf(user.id))[0].reverted).toBeNull()
      })
    })
  }
)
