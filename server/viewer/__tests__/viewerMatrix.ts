// 请求视角矩阵的共享夹具 (不是测试文件): 同一个原始 Cookie 头同时喂给
// Route Handler (NextRequest) 与页面读取器 (next/headers mock), 两侧共用一张
// 假会话表、一份 Redis / Prisma / Meilisearch 记录器。各测试文件自己声明
// vi.mock, 在工厂里 await import 本模块取出对应的 mock 模块对象。
//
// 只 mock 重构不会移动的接缝 (jwt / redis / prisma / next/headers / react cache /
// hasPendingResource / Meilisearch 查询), 可见性 helper 与列表 service 全部走真实代码
import { NextRequest } from 'next/server'
import { RequestCookies } from 'next/dist/compiled/@edge-runtime/cookies'

export const TOKEN_COOKIE = 'kun-galgame-patch-moe-token'
export const NSFW_COOKIE = 'kun-patch-setting-store|state|data|kunNsfwEnable'
export const MIRROR_COOKIE =
  'kun-patch-setting-store|state|data|kunBlockedTagIds'

export interface MatrixPayload {
  iss: string
  aud: string
  jti: string
  uid: number
  name: string
  role: number
}

export interface MatrixUser {
  id: number
  name: string
  role: number
  status: number
  blocked_tag_ids: number[]
}

export interface MatrixSession {
  token: string
  payload: MatrixPayload
  user: MatrixUser
}

export interface MatrixViewer {
  name: string
  cookieHeader: string
  session: MatrixSession | null
}

interface CookieParts {
  token?: string
  nsfw?: string
  // 原样写进 Cookie 头的镜像值 (js-cookie 把逗号写成 %2C)
  mirror?: string
}

export const buildCookieHeader = ({ token, nsfw, mirror }: CookieParts) =>
  [
    token === undefined ? null : `${TOKEN_COOKIE}=${token}`,
    nsfw === undefined ? null : `${NSFW_COOKIE}=${nsfw}`,
    mirror === undefined ? null : `${MIRROR_COOKIE}=${mirror}`
  ]
    .filter((part): part is string => part !== null)
    .join('; ')

export const buildSession = (
  uid: number,
  role: number,
  blockedTagIds: number[] = []
): MatrixSession => ({
  token: `tok-${uid}`,
  payload: { iss: '', aud: '', jti: 'j', uid, name: `kun${uid}`, role },
  user: {
    id: uid,
    name: `kun${uid}`,
    role,
    status: 0,
    blocked_tag_ids: blockedTagIds
  }
})

const loggedIn = (
  name: string,
  session: MatrixSession,
  cookies: Omit<CookieParts, 'token'> = {}
): MatrixViewer => ({
  name,
  cookieHeader: buildCookieHeader({ token: session.token, ...cookies }),
  session
})

export const STALE_TOKEN = 'tok-stale'

// uid 两位数, 首位区分组别; 各视角 uid 互不相同, 便于从 where 里认出是谁
export const V = {
  guest: { name: 'guest', cookieHeader: '', session: null },
  // 没有 token, 却带着放开 NSFW 与屏蔽标签的 cookie: 必须与 guest 完全相同
  guestForged: {
    name: 'guest-forged',
    cookieHeader: buildCookieHeader({ nsfw: 'all', mirror: '[7%2C8]' }),
    session: null
  },
  // 会话表不认的 token + 同样的伪造 cookie: 必须与 guest 完全相同
  staleToken: {
    name: 'stale-token',
    cookieHeader: buildCookieHeader({
      token: STALE_TOKEN,
      nsfw: 'all',
      mirror: '[7%2C8]'
    }),
    session: null
  },
  userSfw: loggedIn('user-sfw', buildSession(11, 1)),
  userAll: loggedIn('user-all', buildSession(12, 1), { nsfw: 'all' }),
  userNsfw: loggedIn('user-nsfw', buildSession(13, 1), { nsfw: 'nsfw' }),
  // 屏蔽列表只取鉴权结果 (DB), cookie 里的副本不被采信。副本与 DB 不同: 结果为 DB 的 [10, 20]
  blockerMirror: loggedIn('blocker-mirror', buildSession(21, 1, [10, 20]), {
    mirror: '[8%2C7]'
  }),
  blockerDb: loggedIn('blocker-db', buildSession(22, 1, [10, 20])),
  // 副本是畸形转义 / 坏 JSON: 同样无关, 结果为 DB 的 [10, 20]
  blockerBadEscape: loggedIn(
    'blocker-bad-escape',
    buildSession(23, 1, [10, 20]),
    { mirror: '%2' }
  ),
  blockerBadJson: loggedIn('blocker-bad-json', buildSession(24, 1, [10, 20]), {
    mirror: 'kun'
  }),
  // DB 里没有屏蔽, cookie 里却带着一份副本: 不被采信, 与 user-sfw 同视角
  mirrorOnly: loggedIn('mirror-only', buildSession(25, 1), {
    mirror: '[7%2C8]'
  }),
  // role 2 且 hasPendingResource → true (见 PENDING_RESOURCE_UIDS)
  pendingAuthor: loggedIn('pending-author', buildSession(31, 2)),
  admin: loggedIn('admin', buildSession(41, 3)),
  adminBlocker: loggedIn('admin-blocker', buildSession(42, 3, [7, 8])),
  superAdminSfw: loggedIn('super-admin-sfw', buildSession(51, 4), {
    nsfw: 'sfw'
  }),
  superAdminNsfw: loggedIn('super-admin-nsfw', buildSession(52, 4), {
    nsfw: 'nsfw'
  }),
  superAdminAll: loggedIn('super-admin-all', buildSession(53, 4), {
    nsfw: 'all'
  }),
  superAdminBlocker: loggedIn(
    'super-admin-blocker',
    buildSession(54, 4, [7, 8]),
    { nsfw: 'all' }
  )
} satisfies Record<string, MatrixViewer>

export const PENDING_RESOURCE_UIDS = new Set([31])

const SESSION_TABLE = new Map<string, MatrixSession>(
  Object.values(V)
    .map((viewer) => viewer.session)
    .filter((session): session is MatrixSession => session !== null)
    .map((session) => [session.token, session])
)

// ---- 可见性 where 字面量 (getPatchVisibilityWhere 的今日输出形状) ----

export const SFW = { content_limit: 'sfw' }
export const NSFW_ONLY = { content_limit: 'nsfw' }
export const ALL = {}
export const SFW_BLOCK_7_8 = {
  content_limit: 'sfw',
  NOT: { tag: { some: { tag_id: { in: [7, 8] } } } }
}
export const SFW_BLOCK_10_20 = {
  content_limit: 'sfw',
  NOT: { tag: { some: { tag_id: { in: [10, 20] } } } }
}

// getResourceVisibilityWhere 的三种输出
export const PUBLIC_STATUS = { status: 0 }
export const ADMIN_STATUS = { status: { in: [0, 2, 3] } }
export const ownStatus = (uid: number) => ({
  OR: [{ status: 0 }, { status: { in: [2, 3] }, user_id: uid }]
})

// 索引命中的 id 回 PG 取卡片 (fetchGalgameCardsByIds): 同一个视角的可见性与 id 条件 AND 在一起
export const hydrationQueries = (ids: number[], patch: object) => [
  { call: 'patch.findMany', where: { AND: [{ id: { in: ids } }, patch] } }
]

// ---- 记录器 ----

export type RedisCall = [op: string, ...args: unknown[]]

export interface PrismaCall {
  call: string
  where: unknown
}

export interface MeiliCall {
  filter: unknown
}

export interface Recording<T = unknown> {
  result: T
  prisma: PrismaCall[]
  redis: RedisCall[]
  meili: MeiliCall[]
}

interface MatrixState {
  cookieHeader: string
  meiliEnabled: boolean
  // 索引查询返回的 id (默认没有命中)
  meiliIds: number[]
  // 每次 record() 开始时写入 Redis 内存表的初值 (版本键等)
  redisSeed: Record<string, string>
  // 'model.method' → 返回值; 未配置的按方法名给空结果
  prismaResults: Record<string, unknown>
  redisStore: Map<string, string>
  prisma: PrismaCall[]
  redis: RedisCall[]
  meili: MeiliCall[]
  memo: Array<{ fn: unknown; args: unknown[]; result: unknown }>
}

export const matrixState: MatrixState = {
  cookieHeader: '',
  meiliEnabled: false,
  meiliIds: [],
  redisSeed: {},
  prismaResults: {},
  redisStore: new Map(),
  prisma: [],
  redis: [],
  meili: [],
  memo: []
}

// 每个测试开头调用: 清掉上一个测试留下的配置
export const resetMatrix = () => {
  matrixState.cookieHeader = ''
  matrixState.meiliEnabled = false
  matrixState.meiliIds = []
  matrixState.redisSeed = {}
  matrixState.prismaResults = {}
  matrixState.redisStore = new Map()
  matrixState.prisma = []
  matrixState.redis = []
  matrixState.meili = []
  matrixState.memo = []
}

// 一次 record = 一个请求: 换 Cookie 头、清空 React cache 与全部记录
export const record = async <T>(
  viewer: MatrixViewer,
  run: () => Promise<T>
): Promise<Recording<T>> => {
  matrixState.cookieHeader = viewer.cookieHeader
  matrixState.redisStore = new Map(Object.entries(matrixState.redisSeed))
  matrixState.prisma = []
  matrixState.redis = []
  matrixState.meili = []
  matrixState.memo = []

  const result = await run()

  return {
    result,
    prisma: matrixState.prisma,
    redis: matrixState.redis,
    meili: matrixState.meili
  }
}

// 两种传输方式的「对外交互」: 比较 route 与 loader 时不含返回值
export const interactions = ({ prisma, redis, meili }: Recording) => ({
  prisma,
  redis,
  meili
})

// 共享缓存未命中的完整轨迹: 读 → 取锁 → 锁内重读 → 回源后写 → 释放锁
export const sharedMissTrace = (key: string, ttl: number): RedisCall[] => [
  ['getKv', key],
  ['acquireKvLock', `${key}:lock`, 10],
  ['getKv', key],
  ['setKv', key, ttl],
  ['releaseKvLock', `${key}:lock`]
]

// ---- 请求构造 ----

const withCookie = (viewer: MatrixViewer): Record<string, string> =>
  viewer.cookieHeader ? { cookie: viewer.cookieHeader } : {}

export const getRequest = (path: string, viewer: MatrixViewer) =>
  new NextRequest(`http://localhost${path}`, { headers: withCookie(viewer) })

export const postRequest = (
  path: string,
  viewer: MatrixViewer,
  body: unknown
) =>
  new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { ...withCookie(viewer), 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

export const readJson = async (response: Response) =>
  (await response.json()) as unknown

// ---- mock 模块对象 (供各测试文件的 vi.mock 工厂返回) ----

const clone = <T>(value: T): T => structuredClone(value)

export const jwtModule = {
  verifyKunTokenWithUser: async (token: string) => {
    const session = SESSION_TABLE.get(token)
    return session
      ? { payload: clone(session.payload), user: clone(session.user) }
      : null
  },
  verifyKunToken: async (token: string) => {
    const session = SESSION_TABLE.get(token)
    return session ? clone(session.payload) : null
  }
}

export const nextHeadersModule = {
  cookies: async () =>
    new RequestCookies(new Headers({ cookie: matrixState.cookieHeader })),
  headers: async () => new Headers({ cookie: matrixState.cookieHeader })
}

// React cache: 按 (fn, args) 记忆, record() 时清空 (一次 record 即一次 render)
export const memoCache = <Args extends unknown[], Result>(
  fn: (...args: Args) => Result
) => {
  return (...args: Args): Result => {
    const hit = matrixState.memo.find(
      (entry) =>
        Object.is(entry.fn, fn) &&
        entry.args.length === args.length &&
        entry.args.every((argument, index) => Object.is(argument, args[index]))
    )
    if (hit) {
      return hit.result as Result
    }
    const result = fn(...args)
    matrixState.memo.push({ fn, args, result })
    return result
  }
}

const pushRedis = (...call: RedisCall) => {
  matrixState.redis.push(call)
}

export const redisModule = {
  getKv: async (key: string) => {
    pushRedis('getKv', key)
    return matrixState.redisStore.get(key) ?? null
  },
  getKvs: async (keys: string[]) => {
    pushRedis('getKvs', [...keys])
    return keys.map((key) => matrixState.redisStore.get(key) ?? null)
  },
  // 写入值是查询结果的 JSON, 与视角无关的部分不记录, 只记键与 TTL
  setKv: async (key: string, value: string, ttl?: number) => {
    pushRedis('setKv', key, ttl)
    matrixState.redisStore.set(key, value)
  },
  setKvIfAbsent: async (key: string, value: string, ttl?: number) => {
    pushRedis('setKvIfAbsent', key, ttl)
    if (!matrixState.redisStore.has(key)) {
      matrixState.redisStore.set(key, value)
    }
    return true
  },
  delKv: async (key: string) => {
    pushRedis('delKv', key)
    matrixState.redisStore.delete(key)
  },
  delKvs: async (keys: string[]) => {
    pushRedis('delKvs', [...keys])
  },
  takeKv: async (key: string) => {
    pushRedis('takeKv', key)
    return null
  },
  acquireKvLock: async (key: string, ttlSeconds = 10) => {
    pushRedis('acquireKvLock', key, ttlSeconds)
    return 'lock-token'
  },
  releaseKvLock: async (key: string) => {
    pushRedis('releaseKvLock', key)
  },
  renewKvLock: async (key: string) => {
    pushRedis('renewKvLock', key)
    return true
  },
  evalKvScript: async (...args: unknown[]) => {
    pushRedis('evalKvScript', ...args)
    return null
  },
  runRedisCommand: async (command: () => Promise<unknown>) => {
    pushRedis('runRedisCommand')
    return command()
  },
  setKvsAndAddKvSetMembers: async (...args: unknown[]) => {
    pushRedis('setKvsAndAddKvSetMembers', ...args)
  },
  delKvsAndRemoveKvSetMembers: async (...args: unknown[]) => {
    pushRedis('delKvsAndRemoveKvSetMembers', ...args)
  },
  getKvSetMembers: async (key: string) => {
    pushRedis('getKvSetMembers', key)
    return []
  },
  addKvSetMembers: async (key: string) => {
    pushRedis('addKvSetMembers', key)
  },
  removeKvSetMembers: async (key: string) => {
    pushRedis('removeKvSetMembers', key)
  },
  getKvHashAll: async (key: string) => {
    pushRedis('getKvHashAll', key)
    return {}
  },
  setKvHashFields: async (key: string) => {
    pushRedis('setKvHashFields', key)
  },
  setKvAndExpireKvIfTtlLessThan: async (key: string) => {
    pushRedis('setKvAndExpireKvIfTtlLessThan', key)
  },
  redis: {}
}

const defaultPrismaResult = (method: string) => {
  if (method === 'findMany') {
    return []
  }
  if (method === 'count') {
    return 0
  }
  return null
}

// prisma.<model>.<method>(args): 记录 where, 按配置或方法名返回
const prismaProxy = new Proxy(
  {},
  {
    get: (_target, model) => {
      if (typeof model !== 'string' || model === 'then') {
        return undefined
      }
      return new Proxy(
        {},
        {
          get: (_modelTarget, method) => {
            if (typeof method !== 'string' || method === 'then') {
              return undefined
            }
            return async (args?: { where?: unknown }) => {
              const call = `${model}.${method}`
              matrixState.prisma.push({ call, where: clone(args?.where) })
              return call in matrixState.prismaResults
                ? clone(matrixState.prismaResults[call])
                : defaultPrismaResult(method)
            }
          }
        }
      )
    }
  }
)

export const prismaModule = { prisma: prismaProxy }

export const pendingResourceModule = {
  hasPendingResource: async (uid: number) => PENDING_RESOURCE_UIDS.has(uid),
  invalidateUserPendingResourceCache: async () => undefined
}

export const meiliModule = {
  isMeiliEnabled: () => matrixState.meiliEnabled
}

export const searchQueryModule = {
  queryGalgameIds: async (params: { filter?: unknown }) => {
    matrixState.meili.push({ filter: params.filter })
    return {
      ids: [...matrixState.meiliIds],
      total: matrixState.meiliIds.length
    }
  }
}

export const searchResolveModule = {
  resolveTagIdsByNames: async () => new Map<string, number[]>(),
  resolveCompanyIdsByNames: async () => new Map<string, number[]>()
}
