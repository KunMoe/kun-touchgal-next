import { randomUUID } from 'crypto'

// In-memory stand-in for the parts of ~/lib/redis that the session / credential code uses.
// Semantics follow lib/redis.ts (including its Lua scripts and MULTI blocks); keys are stored
// without the `kun:touchgal` prefix, exactly as callers pass them. TTLs are wall-clock based on
// Date.now(), so vi.setSystemTime moves them; expired keys read as absent.
//
// Usage (vi.mock factories run at import time, so build the instance in vi.hoisted):
//   const redis = await vi.hoisted(async () =>
//     (await import('~/server/auth/__tests__/_redisFake')).createRedisFake()
//   )
//   vi.mock('~/lib/redis', () => redis.module)
//
// Only functions listed in `module` exist on the mock: importing anything else makes vitest
// throw on access, so an unmodelled Redis call cannot silently pass.

type Entry =
  | { type: 'string'; value: string; expiresAt: number | null }
  | { type: 'set'; members: Set<string>; expiresAt: number | null }

interface KvValue {
  key: string
  value: string
  ttlSeconds?: number
}

interface KvSetMembers {
  key: string
  members: string[]
  setTtlSeconds?: number
}

export type RedisFakeCall = { fn: string; args: unknown[] }

const wrongType = () =>
  new Error('WRONGTYPE Operation against a key holding the wrong kind of value')

export const createRedisFake = () => {
  const store = new Map<string, Entry>()
  // One entry per Redis round trip (calls that return early without a round trip are not logged)
  const calls: RedisFakeCall[] = []
  const failures = new Map<string, unknown[]>()
  const beforeHooks = new Map<string, (() => unknown)[]>()
  const afterHooks = new Map<string, (() => unknown)[]>()

  const live = (key: string) => {
    const entry = store.get(key)
    if (!entry) {
      return undefined
    }
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key)
      return undefined
    }
    return entry
  }

  // Redis TTL: -2 missing, -1 no expiry, otherwise remaining seconds
  const ttlOf = (key: string) => {
    const entry = live(key)
    if (!entry) {
      return -2
    }
    if (entry.expiresAt === null) {
      return -1
    }
    return Math.round((entry.expiresAt - Date.now()) / 1000)
  }

  // SET / SETEX: a plain SET drops any previous TTL
  const writeString = (key: string, value: string, ttlSeconds?: number) => {
    store.set(key, {
      type: 'string',
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null
    })
  }

  const readString = (key: string) => {
    const entry = live(key)
    if (!entry) {
      return null
    }
    if (entry.type !== 'string') {
      throw wrongType()
    }
    return entry.value
  }

  // EXPIRE on a missing key is a no-op
  const expire = (key: string, seconds: number) => {
    const entry = live(key)
    if (entry) {
      entry.expiresAt = Date.now() + seconds * 1000
    }
  }

  const sadd = (key: string, members: string[]) => {
    let entry = live(key)
    if (!entry) {
      entry = { type: 'set', members: new Set(), expiresAt: null }
      store.set(key, entry)
    }
    if (entry.type !== 'set') {
      throw wrongType()
    }
    for (const member of members) {
      entry.members.add(member)
    }
  }

  // SREM that empties a set removes the key, as in Redis
  const srem = (key: string, members: string[]) => {
    const entry = live(key)
    if (!entry) {
      return
    }
    if (entry.type !== 'set') {
      throw wrongType()
    }
    for (const member of members) {
      entry.members.delete(member)
    }
    if (entry.members.size === 0) {
      store.delete(key)
    }
  }

  const del = (key: string) => {
    store.delete(key)
  }

  // Each round trip: log it, run a queued hook (to interleave another request), then a queued failure
  const enter = async (fn: string, args: unknown[]) => {
    calls.push({ fn, args: structuredClone(args) })
    const hook = beforeHooks.get(fn)?.shift()
    if (hook) {
      await hook()
    }
    const queued = failures.get(fn)
    if (queued?.length) {
      throw queued.shift()
    }
  }

  const redisModule = {
    getKv: async (key: string) => {
      await enter('getKv', [key])
      return readString(key)
    },
    setKv: async (key: string, value: string, time?: number) => {
      await enter('setKv', [key, value, time])
      writeString(key, value, time)
    },
    delKv: async (key: string) => {
      await enter('delKv', [key])
      del(key)
    },
    takeKv: async (key: string) => {
      await enter('takeKv', [key])
      const existed = live(key) !== undefined
      del(key)
      return existed
    },
    setKvIfAbsent: async (key: string, value: string, time: number) => {
      await enter('setKvIfAbsent', [key, value, time])
      if (live(key)) {
        return false
      }
      writeString(key, value, time)
      return true
    },
    // MGET: wrong-type keys read as nil
    getKvs: async (keys: string[]) => {
      if (keys.length === 0) {
        return []
      }
      await enter('getKvs', [keys])
      return keys.map((key) => {
        const entry = live(key)
        return entry?.type === 'string' ? entry.value : null
      })
    },
    delKvs: async (keys: string[]) => {
      if (keys.length === 0) {
        return
      }
      await enter('delKvs', [keys])
      keys.forEach(del)
    },
    getKvSetMembers: async (key: string) => {
      await enter('getKvSetMembers', [key])
      const entry = live(key)
      if (!entry) {
        return []
      }
      if (entry.type !== 'set') {
        throw wrongType()
      }
      return [...entry.members]
    },
    // Mirrors SET_KVS_AND_ADD_SET_MEMBERS_EXTEND_TTL_SCRIPT when setTtlSeconds > 0, else the MULTI
    setKvsAndAddKvSetMembers: async (values: KvValue[], set: KvSetMembers) => {
      const { key: setKey, members, setTtlSeconds } = set
      const shouldExtendSetTtl =
        typeof setTtlSeconds === 'number' && setTtlSeconds > 0
      if (values.length === 0 && members.length === 0 && !shouldExtendSetTtl) {
        return
      }
      await enter('setKvsAndAddKvSetMembers', [values, set])

      for (const { key, value, ttlSeconds } of values) {
        writeString(key, value, ttlSeconds && ttlSeconds > 0 ? ttlSeconds : 0)
      }
      if (members.length > 0) {
        sadd(setKey, members)
      }
      if (shouldExtendSetTtl) {
        const currentTtl = ttlOf(setKey)
        if (currentTtl < 0 || currentTtl < setTtlSeconds) {
          expire(setKey, setTtlSeconds)
        }
      }
    },
    delKvsAndRemoveKvSetMembers: async (
      keys: string[],
      setKey: string,
      members: string[]
    ) => {
      if (keys.length === 0 && members.length === 0) {
        return
      }
      await enter('delKvsAndRemoveKvSetMembers', [keys, setKey, members])
      keys.forEach(del)
      if (members.length > 0) {
        srem(setKey, members)
      }
    },
    // SETEX key + EXPIRE_KV_IF_TTL_LESS_THAN_SCRIPT on ttlKey, in one pipeline
    setKvAndExpireKvIfTtlLessThan: async (
      key: string,
      value: string,
      keyTime: number,
      ttlKey: string,
      ttlTime: number
    ) => {
      if (keyTime <= 0) {
        return
      }
      await enter('setKvAndExpireKvIfTtlLessThan', [
        key,
        value,
        keyTime,
        ttlKey,
        ttlTime
      ])
      writeString(key, value, keyTime)
      if (ttlTime > 0) {
        const currentTtl = ttlOf(ttlKey)
        if (currentTtl < 0 || currentTtl < ttlTime) {
          expire(ttlKey, ttlTime)
        }
      }
    },
    acquireKvLock: async (key: string, ttlSeconds = 10) => {
      await enter('acquireKvLock', [key, ttlSeconds])
      if (live(key)) {
        return null
      }
      const token = randomUUID()
      writeString(key, token, ttlSeconds)
      return token
    },
    releaseKvLock: async (key: string, token: string) => {
      await enter('releaseKvLock', [key, token])
      if (readString(key) === token) {
        del(key)
      }
    }
  }

  // After the effect, before the caller resumes: lets a test run another request in the window
  // between two round trips of the code under test (e.g. between a GET and the DEL that follows)
  const withAfterHooks = <
    T extends Record<string, (...args: never[]) => Promise<unknown>>
  >(
    fns: T
  ) =>
    Object.fromEntries(
      Object.entries(fns).map(([name, fn]) => [
        name,
        async (...args: never[]) => {
          const result = await fn(...args)
          const hook = afterHooks.get(name)?.shift()
          if (hook) {
            await hook()
          }
          return result
        }
      ])
    ) as T

  return {
    module: withAfterHooks(redisModule),
    calls,
    callNames: () => calls.map((call) => call.fn),
    // Inspection / seeding helpers: not logged as calls
    get: (key: string) => {
      const entry = live(key)
      return entry?.type === 'string' ? entry.value : null
    },
    members: (key: string) => {
      const entry = live(key)
      return entry?.type === 'set' ? [...entry.members].sort() : []
    },
    has: (key: string) => live(key) !== undefined,
    ttl: ttlOf,
    keys: () => [...store.keys()].filter((key) => live(key)).sort(),
    put: (key: string, value: string, ttlSeconds?: number) => {
      writeString(key, value, ttlSeconds)
    },
    putSet: (key: string, members: string[], ttlSeconds?: number) => {
      store.set(key, {
        type: 'set',
        members: new Set(members),
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null
      })
    },
    // The next call to `fn` rejects with `error` (after any queued hook)
    failNext: (fn: string, error: unknown = new Error('redis unavailable')) => {
      failures.set(fn, [...(failures.get(fn) ?? []), error])
    },
    // The next call to `fn` awaits `hook` before taking effect (models a concurrent request)
    beforeNext: (fn: string, hook: () => unknown) => {
      beforeHooks.set(fn, [...(beforeHooks.get(fn) ?? []), hook])
    },
    // The next call to `fn` takes effect, then awaits `hook` before resolving to the caller
    afterNext: (fn: string, hook: () => unknown) => {
      afterHooks.set(fn, [...(afterHooks.get(fn) ?? []), hook])
    },
    reset: () => {
      store.clear()
      calls.length = 0
      failures.clear()
      beforeHooks.clear()
      afterHooks.clear()
    }
  }
}

export type RedisFake = ReturnType<typeof createRedisFake>
