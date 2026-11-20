import { beforeEach, describe, expect, it } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'
import { pgErrors } from '~/prisma/__tests__/support/pgErrorFixtures'
import { createSqlRecorder } from '~/prisma/__tests__/support/sqlRecorder'
import { isPrismaTransactionConflict } from '~/server/db/txErrors'
import { kunViolationCodeOf } from '~/server/db/violations'

// 错误映射契约: 驱动报的 PostgreSQL 错误经真实的 adapter 与客户端引擎之后, 应用拿到的是
// 什么。应用的两份判据 —— kunViolationCodeOf (违例文案) 与 isPrismaTransactionConflict
// (事务重放) —— 在这里对着映射的真实产出求值; 它们各自的单测用的是手写对象, 映射变了照样绿。
// 不连库 (见 support/sqlRecorder.ts); 回放的字段集取自真库, 由 pgErrorFixtures.db.test.ts 保鲜。

const recorder = createSqlRecorder()
const { prisma } = recorder

const errorOf = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to reject')
}

// meta.driverAdapterError.cause: adapter 对驱动错误的转述
const adapterCauseOf = (error: unknown) =>
  (
    error as {
      meta?: { driverAdapterError?: { cause?: Record<string, unknown> } }
    }
  ).meta?.driverAdapterError?.cause

const rename = () =>
  prisma.user.updateMany({ where: { id: 42 }, data: { name: 'kun' } })

beforeEach(() => {
  recorder.reset()
})

describe('约束类违例', () => {
  it('唯一约束 (23505) 映射为 P2002; 约束名在 meta.driverAdapterError.cause 里, meta.target 是空的', async () => {
    recorder.reply(/^UPDATE/, { error: pgErrors.uniqueViolation })

    const error = await errorOf(rename)

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect(error).toMatchObject({ code: 'P2002' })
    expect(kunViolationCodeOf(error)).toBe('P2002')
    expect((error as { meta: object }).meta).not.toHaveProperty('target')
    expect(adapterCauseOf(error)).toMatchObject({
      originalCode: '23505',
      kind: 'UniqueConstraintViolation',
      constraint: { index: 'user_name_key' },
      table: 'user'
    })
    expect(isPrismaTransactionConflict(error)).toBe(false)
  })

  it('复合唯一约束同样只给出约束名, 不给列名', async () => {
    recorder.reply(/^INSERT/, { error: pgErrors.uniqueViolationComposite })

    const error = await errorOf(() =>
      prisma.user_conversation.create({ data: { user_a_id: 1, user_b_id: 2 } })
    )

    expect(kunViolationCodeOf(error)).toBe('P2002')
    expect(adapterCauseOf(error)).toMatchObject({
      constraint: { index: 'user_conversation_user_a_id_user_b_id_key' }
    })
  })

  it('外键 (23503) 映射为 P2003', async () => {
    recorder.reply(/^INSERT/, { error: pgErrors.foreignKeyViolation })

    const error = await errorOf(() =>
      prisma.user_conversation.create({
        data: { user_a_id: 1, user_b_id: 2147480000 }
      })
    )

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect(kunViolationCodeOf(error)).toBe('P2003')
    expect(adapterCauseOf(error)).toMatchObject({
      originalCode: '23503',
      kind: 'ForeignKeyConstraintViolation'
    })
  })

  it.each([
    [
      'update',
      () => prisma.user.update({ where: { id: 42 }, data: { bio: '' } })
    ],
    ['delete', () => prisma.patch.delete({ where: { id: 42 } })]
  ])('%s 命中 0 行时抛 P2025', async (_operation, run) => {
    const error = await errorOf(run)

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect(kunViolationCodeOf(error)).toBe('P2025')
  })

  // 不在违例表里: 这是该在 Zod 层拦下的输入, 由 kunRoute 记日志后原样抛出
  it('越界的 int4 参数 (22003) 映射为 P2020, 不算可翻译的违例', async () => {
    recorder.reply(/^SELECT/, { error: pgErrors.valueOutOfRange })

    const error = await errorOf(() =>
      prisma.user.findUnique({
        where: { id: 2147483648 },
        select: { id: true }
      })
    )

    expect(error).toMatchObject({ code: 'P2020' })
    expect(kunViolationCodeOf(error)).toBeUndefined()
  })

  // 原生语句里撞约束拿不到 P2002 / P2003: 违例文案与路由边界的兜底都认不出它
  it('原生语句的错误一律是 P2010, 约束违例也不例外', async () => {
    recorder.reply(/^INSERT/, { error: pgErrors.uniqueViolationComposite })

    const error = await errorOf(
      () =>
        prisma.$executeRaw`INSERT INTO user_conversation (user_a_id, user_b_id) VALUES (${1}, ${2})`
    )

    expect(error).toMatchObject({ code: 'P2010' })
    expect(kunViolationCodeOf(error)).toBeUndefined()
    expect(adapterCauseOf(error)).toMatchObject({ originalCode: '23505' })
  })
})

describe.each([
  ['死锁 (40P01)', pgErrors.deadlockDetected],
  ['串行化失败 (40001)', pgErrors.serializationFailure]
])('事务冲突: %s', (_name, conflict) => {
  const bump = (client: Pick<typeof prisma, 'user'>) =>
    client.user.updateMany({
      where: { id: 42 },
      data: { moemoepoint: { increment: 1 } }
    })

  it('事务里的模型调用: P2034, 判据认得出', async () => {
    recorder.reply(/^UPDATE/, { error: conflict })

    const error = await errorOf(() => prisma.$transaction((tx) => bump(tx)))

    expect(error).toMatchObject({ code: 'P2034' })
    expect(adapterCauseOf(error)).toMatchObject({
      originalCode: conflict.code,
      kind: 'TransactionWriteConflict'
    })
    expect(isPrismaTransactionConflict(error)).toBe(true)
  })

  it('自动提交的模型调用: 同样是 P2034', async () => {
    recorder.reply(/^UPDATE/, { error: conflict })

    const error = await errorOf(() => bump(prisma))

    expect(error).toMatchObject({ code: 'P2034' })
    expect(isPrismaTransactionConflict(error)).toBe(true)
  })

  it.each([
    [
      '事务里',
      () =>
        prisma.$transaction(
          (tx) =>
            tx.$executeRaw`UPDATE patch SET view = view + 1 WHERE id = ${1}`
        )
    ],
    [
      '事务外',
      () => prisma.$executeRaw`UPDATE patch SET view = view + 1 WHERE id = ${1}`
    ]
  ])('%s的原生语句: P2010, 判据靠 originalCode 认出', async (_where, run) => {
    recorder.reply(/^UPDATE/, { error: conflict })

    const error = await errorOf(run)

    expect(error).toMatchObject({ code: 'P2010' })
    expect(adapterCauseOf(error)).toMatchObject({ originalCode: conflict.code })
    expect(isPrismaTransactionConflict(error)).toBe(true)
  })
})
