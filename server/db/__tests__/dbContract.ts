// 应用层在真实 PostgreSQL 上的用例 (条件更新在并发下由库重新判定、事务回滚、唯一约束)
// 的入口。只在给了 KUN_DB_CONTRACT_URL 时运行:
//   docker run --rm -d --name kun-db-scratch -p 127.0.0.1:55433:5432 --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=kun postgres:17-alpine
//   KUN_DB_SCRATCH_URL=postgresql://postgres:kun@127.0.0.1:55433/postgres pnpm db:snapshot --check   # 把全部迁移回放进去
//   KUN_DB_CONTRACT_URL=postgresql://postgres:kun@127.0.0.1:55433/postgres pnpm exec vitest run server/auth/__tests__/emailChange.db.test.ts
// 用例会建用户、写数据, 所以绝不能连到开发库 (那是生产数据的副本)。三道防线:
// 只认回环地址; 连上之后经应用自己的 prisma 单例核对库名 (.env 里的 KUN_DATABASE_URL 不得
// 生效); user 表必须是空的
export const dbContractUrl = process.env.KUN_DB_CONTRACT_URL

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export const openDbContract = async () => {
  if (!dbContractUrl) {
    throw new Error('KUN_DB_CONTRACT_URL is not set')
  }
  const url = new URL(dbContractUrl)
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `KUN_DB_CONTRACT_URL must point at a loopback address, got ${url.hostname}`
    )
  }

  // prisma/index.ts 在加载时读这个变量; dotenv 不覆盖已有的值, 所以先设好再动态导入
  process.env.KUN_DATABASE_URL = dbContractUrl
  const { prisma } = await import('~/prisma/index')

  const [target] = await prisma.$queryRaw<
    { database: string; users: bigint }[]
  >`SELECT current_database() AS database, (SELECT count(*) FROM "user") AS users`
  const expectedDatabase = decodeURIComponent(url.pathname.slice(1))
  if (target.database !== expectedDatabase || target.users !== 0n) {
    await prisma.$disconnect()
    throw new Error(
      `refusing to run against ${target.database} (expected an empty ${expectedDatabase}, found ${target.users} users)`
    )
  }

  return prisma
}
