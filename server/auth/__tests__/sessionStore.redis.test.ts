import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  contractSubjectId,
  openRedisContract,
  redisContractUrl
} from '~/lib/__tests__/redisContract'
import type { RedisContract } from '~/lib/__tests__/redisContract'

// 会话存储用到的两个条件写原语在真 Redis 上的语义 (运行方式见 lib/__tests__/redisContract.ts)。
// 单测里的内存假件照着它们建模; 这里钉住真实的 Lua 与 SET … XX

describe.skipIf(!redisContractUrl)(
  'session store primitives on real Redis',
  () => {
    let kv: RedisContract
    let redisLib: typeof import('~/lib/redis')
    let createdKeys: string[] = []

    beforeAll(async () => {
      kv = await openRedisContract()
      redisLib = await import('~/lib/redis')
    })

    afterEach(async () => {
      if (createdKeys.length) {
        await kv.del(...createdKeys)
      }
      createdKeys = []
    })

    afterAll(() => {
      kv?.close()
    })

    const keysFor = () => {
      const uid = contractSubjectId()
      const jti = randomUUID()
      const keys = {
        token: `access:token:${uid}:${jti}`,
        session: `access:session:${uid}:${jti}`,
        set: `access:sessions:${uid}`,
        jti
      }
      createdKeys.push(keys.token, keys.session, keys.set)
      return keys
    }

    describe('delKvsAndRemoveKvSetMembersIfKvEquals', () => {
      it('守卫键仍是期望值: 删键、摘成员, 返回 true; 集合里的其它成员不动', async () => {
        const k = keysFor()
        await kv.set(k.token, 'token-a')
        await kv.set(k.session, '{}')
        await redisLib.addKvSetMembers(k.set, [k.jti, 'other'])

        const removed = await redisLib.delKvsAndRemoveKvSetMembersIfKvEquals(
          k.token,
          'token-a',
          [k.token, k.session],
          k.set,
          [k.jti]
        )

        expect(removed).toBe(true)
        expect(await kv.get(k.token)).toBeNull()
        expect(await kv.get(k.session)).toBeNull()
        expect(await redisLib.getKvSetMembers(k.set)).toEqual(['other'])
      })

      it('守卫键已换成别的值 (会话被重签): 什么都不删, 返回 false', async () => {
        const k = keysFor()
        await kv.set(k.token, 'token-b')
        await kv.set(k.session, '{}')
        await redisLib.addKvSetMembers(k.set, [k.jti])

        const removed = await redisLib.delKvsAndRemoveKvSetMembersIfKvEquals(
          k.token,
          'token-a',
          [k.token, k.session],
          k.set,
          [k.jti]
        )

        expect(removed).toBe(false)
        expect(await kv.get(k.token)).toBe('token-b')
        expect(await kv.get(k.session)).toBe('{}')
        expect(await redisLib.getKvSetMembers(k.set)).toEqual([k.jti])
      })

      it('守卫键不存在: 返回 false', async () => {
        const k = keysFor()

        expect(
          await redisLib.delKvsAndRemoveKvSetMembersIfKvEquals(
            k.token,
            'token-a',
            [k.token],
            k.set,
            [k.jti]
          )
        ).toBe(false)
      })
    })

    describe('replaceKvIfExists', () => {
      it('键还在: 覆盖值并按给定秒数设 TTL', async () => {
        const k = keysFor()
        await kv.set(k.token, 'old')

        expect(await redisLib.replaceKvIfExists(k.token, 'new', 120)).toBe(true)
        expect(await kv.get(k.token)).toBe('new')
        const ttl = await kv.ttl(k.token)
        expect(ttl).toBeGreaterThan(110)
        expect(ttl).toBeLessThanOrEqual(120)
      })

      it('键已被删 (会话已吊销): 不写, 返回 false', async () => {
        const k = keysFor()

        expect(await redisLib.replaceKvIfExists(k.token, 'new', 120)).toBe(
          false
        )
        expect(await kv.get(k.token)).toBeNull()
      })
    })
  }
)
