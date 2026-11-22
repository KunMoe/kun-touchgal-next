// 真 Redis 契约测试的入口: Lua 的原子性、TTL 与并发预留只有在真实例上才测得出来,
// 其余测试一律 mock 了 ~/lib/redis。只在给了 KUN_REDIS_CONTRACT_URL 时运行:
//   docker run --rm -d --name kun-redis-contract -p 127.0.0.1:56379:6379 redis:8.0-alpine
//   KUN_REDIS_CONTRACT_URL=redis://127.0.0.1:56379 pnpm exec vitest run redis.test
// 镜像与生产同主次版本 (8.0)。用例不清库, 只读写自己造的键: 主体 id 取 int4 之外的随机数,
// 不会与真实用户的键相撞。即便如此也只认回环地址 —— 这组用例会把计数器写满
export const redisContractUrl = process.env.KUN_REDIS_CONTRACT_URL

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

// 与 lib/redis.ts 的前缀一致; 前缀变了这组用例会读不到键而失败
const prefixed = (key: string) => `kun:touchgal:${key}`

export const openRedisContract = async () => {
  if (!redisContractUrl) {
    throw new Error('KUN_REDIS_CONTRACT_URL is not set')
  }
  const url = new URL(redisContractUrl)
  if (url.protocol !== 'redis:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `KUN_REDIS_CONTRACT_URL must be a redis:// loopback address, got ${url.protocol}//${url.hostname}`
    )
  }

  // lib/redis.ts 在加载时读这三个变量, 所以必须先设好再动态导入
  process.env.REDIS_HOST = url.hostname.replace(/^\[|\]$/g, '')
  process.env.REDIS_PORT = url.port || '6379'
  process.env.REDIS_PASSWORD = decodeURIComponent(url.password)

  const { redis, runRedisCommand } = await import('~/lib/redis')
  await runRedisCommand(() => redis.ping())

  return {
    get: (key: string) => redis.get(prefixed(key)),
    set: (key: string, value: string) => redis.set(prefixed(key), value),
    hgetall: (key: string) => redis.hgetall(prefixed(key)),
    ttl: (key: string) => redis.ttl(prefixed(key)),
    expire: (key: string, seconds: number) =>
      redis.expire(prefixed(key), seconds),
    pexpire: (key: string, milliseconds: number) =>
      redis.pexpire(prefixed(key), milliseconds),
    persist: (key: string) => redis.persist(prefixed(key)),
    del: (...keys: string[]) => redis.del(...keys.map(prefixed)),
    close: () => redis.disconnect()
  }
}

export type RedisContract = Awaited<ReturnType<typeof openRedisContract>>

// int4 之外: 库里不可能有这个 id 的用户
export const contractSubjectId = () =>
  2 ** 31 + Math.floor(Math.random() * 2 ** 31)
