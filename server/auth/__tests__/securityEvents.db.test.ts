import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'

// 安全戳在真实 PostgreSQL 上的往返 (运行方式见 server/db/__tests__/dbContract.ts)。
// 站点令牌按毫秒值与库里的戳比相等: 写进去再读出来哪怕差一个时区, 强制模式下就是全站登出

describe.skipIf(!dbContractUrl)('security stamp on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let events: typeof import('~/server/auth/securityEvents')
  let createdUserIds: number[] = []

  beforeAll(async () => {
    prisma = await openDbContract()
    events = await import('~/server/auth/securityEvents')
  })

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    createdUserIds = []
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  const newUser = async (password = 'old-hash') => {
    const user = await prisma.user.create({
      data: {
        name: randomUUID().slice(0, 17),
        email: `${randomUUID()}@example.com`,
        password
      }
    })
    createdUserIds.push(user.id)
    return user
  }

  it('新列存量为 null', async () => {
    const user = await newUser()

    expect(user.security_stamp).toBeNull()
  })

  it.each(['UTC', 'Asia/Shanghai', 'America/Los_Angeles'])(
    '会话时区为 %s 时, 写下的戳读回来毫秒值不变',
    async (timeZone) => {
      const user = await newUser()

      const { written, read } = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${timeZone}'`)
        const { stamp } = await events.applyKunCredentialChange(tx, {
          uid: user.id,
          event: 'password-changed',
          data: { password: 'new-hash' }
        })
        const row = await tx.user.findUnique({
          where: { id: user.id },
          select: { security_stamp: true, password: true }
        })
        return { written: stamp, read: row }
      })

      expect(written).toBeInstanceOf(Date)
      expect(read?.password).toBe('new-hash')
      expect(read?.security_stamp?.getTime()).toBe(written?.getTime())
      // 换一个连接 (默认时区) 再读一次
      const again = await prisma.user.findUnique({
        where: { id: user.id },
        select: { security_stamp: true }
      })
      expect(again?.security_stamp?.getTime()).toBe(written?.getTime())
    }
  )

  it('以旧哈希为条件的并发写只有一个命中, 戳也只写一次', async () => {
    const user = await newUser('old-hash')

    const results = await Promise.all(
      ['h1', 'h2', 'h3', 'h4'].map((password) =>
        events.applyKunCredentialChange(prisma, {
          uid: user.id,
          event: 'password-changed',
          where: { password: 'old-hash' },
          data: { password }
        })
      )
    )

    const winners = results.filter((result) => result.count === 1)
    expect(winners).toHaveLength(1)
    expect(results.filter((result) => result.stamp)).toHaveLength(1)
    const row = await prisma.user.findUnique({ where: { id: user.id } })
    expect(row?.security_stamp?.getTime()).toBe(winners[0].stamp?.getTime())
  })

  it('不刷新戳的事件不碰这一列', async () => {
    const user = await newUser('old-hash')

    await events.applyKunCredentialChange(prisma, {
      uid: user.id,
      event: 'password-rehashed',
      where: { password: 'old-hash' },
      data: { password: 'rehashed' }
    })

    const row = await prisma.user.findUnique({ where: { id: user.id } })
    expect(row).toMatchObject({ password: 'rehashed', security_stamp: null })
  })
})
