import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { createSqlRecorder } from '~/prisma/__tests__/support/sqlRecorder'
import { KUN_GLOBAL_OMIT } from '~/prisma/columnPolicy'
import type { KunTx } from '~/prisma/index'

// 列级分级表驱动的全局 omit (prisma/columnPolicy.ts)。业务测试都 mock 了 ~/prisma/index,
// 验证不了运行时的 omit; 这里用录制客户端 (真实的查询编译器) 看 Prisma 实际发出的 SQL。

const HIDDEN_USER_COLUMNS = [
  'email',
  'password',
  'two_factor_secret',
  'two_factor_backup',
  'ip',
  'last_login_time'
] as const

const recorder = createSqlRecorder()
const { prisma } = recorder

beforeEach(() => {
  recorder.reset()
})

const quoted = (column: string) => `"${column}"`

const expectHidden = (sql: string, columns: readonly string[]) => {
  for (const column of columns) {
    expect(sql).not.toContain(quoted(column))
  }
}

describe('分级表', () => {
  it('被隐藏的列与清单逐项一致', () => {
    expect(KUN_GLOBAL_OMIT.user).toEqual(
      Object.fromEntries(HIDDEN_USER_COLUMNS.map((column) => [column, true]))
    )
    // 第二个见证: 分级表里改了某列的类别, 这条类型断言要跟着改 (tsc 检查)
    expectTypeOf<keyof typeof KUN_GLOBAL_OMIT.user>().toEqualTypeOf<
      (typeof HIDDEN_USER_COLUMNS)[number]
    >()
  })

  it('oidc_client 的 client_secret 默认不读', () => {
    expect(KUN_GLOBAL_OMIT.oidc_client).toEqual({ client_secret: true })
  })
})

describe('Prisma 发出的 SQL', () => {
  it('不带 select 的整行读取不含被隐藏的列', async () => {
    await prisma.user.findUnique({ where: { id: 1 } })
    const [read] = recorder.take()
    expect(read.sql).toContain(quoted('name'))
    expectHidden(read.sql, HIDDEN_USER_COLUMNS)
  })

  it('事务回调拿到的 tx 同样带全局 omit', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.user.findUnique({ where: { id: 1 } })
    })
    const [, read] = recorder.take()
    expect(read.sql).toMatch(/^SELECT/)
    expect(read.sql).toContain(quoted('name'))
    expectHidden(read.sql, HIDDEN_USER_COLUMNS)
  })

  it('include 进来的 user 关系同样不含被隐藏的列', async () => {
    // 预置一行资源只为让关系查询发出; 行不完整, 结果的反序列化会失败, 不看结果
    recorder.reply(/FROM "public"\."patch_resource"/, {
      rows: [{ id: 1, user_id: 2 }]
    })
    await prisma.patch_resource
      .findUnique({ where: { id: 1 }, include: { user: true } })
      .catch(() => undefined)
    const userRead = recorder
      .take()
      .find(({ sql }) => sql.includes('FROM "public"."user"'))
    expect(userRead?.sql).toContain(quoted('name'))
    expectHidden(userRead!.sql, HIDDEN_USER_COLUMNS)
  })

  it('update 的 RETURNING 不含被隐藏的列', async () => {
    await prisma.user
      .update({ where: { id: 1 }, data: { bio: 'x' } })
      .catch(() => undefined)
    const [write] = recorder.take()
    expect(write.sql).toMatch(/^UPDATE .* RETURNING /)
    expectHidden(write.sql, HIDDEN_USER_COLUMNS)
  })

  it('omit: { 列: false } 显式取回', async () => {
    await prisma.user.findUnique({
      where: { id: 1 },
      omit: { password: false }
    })
    const [read] = recorder.take()
    expect(read.sql).toContain(quoted('password'))
    expectHidden(
      read.sql,
      HIDDEN_USER_COLUMNS.filter((column) => column !== 'password')
    )
  })

  it('oidc_client 整行读取不含 client_secret, 显式取回才有', async () => {
    await prisma.oidc_client.findUnique({ where: { id: 1 } })
    const [plain] = recorder.take()
    expect(plain.sql).toContain(quoted('client_id'))
    expect(plain.sql).not.toContain(quoted('client_secret'))

    await prisma.oidc_client.findUnique({
      where: { id: 1 },
      omit: { client_secret: false }
    })
    const [retrieved] = recorder.take()
    expect(retrieved.sql).toContain(quoted('client_secret'))
  })
})

// 结果类型与运行时一致: 顶层客户端与 KunTx 都不声称被隐藏的列存在 (tsc 检查)
const readTop = () => prisma.user.findUniqueOrThrow({ where: { id: 1 } })
const readInTx = (tx: KunTx) => tx.user.findUniqueOrThrow({ where: { id: 1 } })
const readPassword = (tx: KunTx) =>
  tx.user.findUniqueOrThrow({
    where: { id: 1 },
    omit: { password: false }
  })
expectTypeOf(readTop).returns.resolves.not.toHaveProperty('password')
expectTypeOf(readInTx).returns.resolves.not.toHaveProperty('password')
expectTypeOf(readPassword).returns.resolves.toHaveProperty('password')
