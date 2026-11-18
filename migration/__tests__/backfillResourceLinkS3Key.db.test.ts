import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'

// s3_key 回填在真实 PostgreSQL 上的行为 (运行方式见 server/db/__tests__/dbContract.ts)。
// 回填之后引用谓词收窄为 s3_key = key (server/storage/references.ts): 回填若写错一行, 收窄后
// 会把仍在用的对象判成无引用。这里钉住「回填前按收窄之前的谓词被引用且存在的对象, 回填后在
// 现行谓词下仍被引用」

const { existingObjects } = vi.hoisted(() => ({
  existingObjects: new Set<string>()
}))

vi.mock('~/lib/s3', () => ({
  headObject: async (key: string) => {
    if (!existingObjects.has(key)) {
      throw Object.assign(new Error('NotFound'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 }
      })
    }
    return {}
  }
}))
vi.mock('~/lib/redis', () => ({}))

const STORAGE_URL = 'https://cloud.example.test'

describe.skipIf(!dbContractUrl)(
  'resource link s3_key backfill on real PostgreSQL',
  () => {
    let prisma: Awaited<ReturnType<typeof openDbContract>>
    let backfill: typeof import('~/migration/backfillResourceLinkS3Key')
    let references: typeof import('~/server/storage/references')
    let userId: number

    beforeAll(async () => {
      prisma = await openDbContract()
      backfill = await import('~/migration/backfillResourceLinkS3Key')
      references = await import('~/server/storage/references')
      const user = await prisma.user.create({
        data: {
          name: randomUUID().slice(0, 17),
          email: `${randomUUID()}@example.com`,
          password: 'x'
        }
      })
      userId = user.id
    })

    afterAll(async () => {
      // patch、资源、链接随用户级联删除
      await prisma?.user.deleteMany({ where: { id: userId } })
      await prisma?.$disconnect()
    })

    const newPatch = () =>
      prisma.patch.create({
        data: {
          unique_id: randomUUID().slice(0, 8),
          name: 's3 key backfill contract',
          user_id: userId
        }
      })

    const newLink = async (
      patchId: number,
      link: {
        content: string
        hash?: string
        s3_key?: string
        storage?: string
      }
    ) =>
      prisma.patch_resource.create({
        data: {
          section: 'galgame',
          user_id: userId,
          patch_id: patchId,
          links: {
            create: {
              storage: link.storage ?? 's3',
              hash: link.hash ?? '',
              s3_key: link.s3_key ?? '',
              content: link.content
            }
          }
        }
      })

    // 收窄之前的谓词: 历史行 (s3_key 为空) 按 content 尾段认领
    const legacyReferenced = async (key: string) => {
      const [row] = await prisma.$queryRaw<{ referenced: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM patch_resource_link
          WHERE s3_key = ${key}::text
            OR (
              s3_key = ''
              AND storage = 's3'
              AND right(content, char_length(${key}::text) + 1) = '/' || ${key}::text
            )
        ) AS referenced`
      return row.referenced
    }
    const narrowedReferenced = (key: string) =>
      references.isS3ObjectReferenced(prisma, key)

    it('回填前被引用且存在的对象, 回填后在收窄的谓词下仍被引用; 第二遍什么也不做', async () => {
      const patch = await newPatch()
      const other = await newPatch()
      const P = patch.id
      const seg = () => randomUUID()

      // 共享对象: 两条链接的 content 相同
      const shared = `patch/${P}/resource/${seg()}/shared.zip`
      // hash 被写空、对象在别的游戏前缀下
      const crossPatch = `patch/${other.id}/resource/${seg()}/cross.zip`
      // 下载地址的对象没了, 按 hash 还原的那个还在
      const tailGone = `patch/${P}/resource/${seg()}/moved.zip`
      const hashSegment = seg()
      const resolvedOnly = `patch/${P}/resource/${hashSegment}/moved.zip`
      // 死链
      const dead = `patch/${P}/resource/${seg()}/dead.zip`
      // 已有 s3_key 的行与外链行不参与回填
      const keyed = `patch/${P}/resource/${seg()}/keyed.zip`
      const external = `patch/${P}/resource/${seg()}/external.zip`

      const sharedHash = shared.split('/')[3]
      await newLink(P, {
        content: `${STORAGE_URL}/${shared}`,
        hash: sharedHash
      })
      await newLink(P, {
        content: `${STORAGE_URL}/${shared}`,
        hash: sharedHash
      })
      await newLink(P, { content: `${STORAGE_URL}/${crossPatch}` })
      await newLink(P, {
        content: `${STORAGE_URL}/${tailGone}`,
        hash: hashSegment
      })
      await newLink(P, {
        content: `${STORAGE_URL}/${dead}`,
        hash: dead.split('/')[3]
      })
      await newLink(P, { content: `${STORAGE_URL}/${keyed}`, s3_key: keyed })
      await newLink(P, {
        content: `${STORAGE_URL}/${external}`,
        storage: 'user'
      })
      for (const key of [shared, crossPatch, resolvedOnly, keyed, external]) {
        existingObjects.add(key)
      }
      const crossPatchResolved = `patch/${P}/resource//cross.zip`
      const keys = [
        shared,
        crossPatch,
        crossPatchResolved,
        tailGone,
        resolvedOnly,
        dead,
        keyed,
        external
      ]

      const before = new Map<string, boolean>()
      for (const key of keys) {
        before.set(key, await legacyReferenced(key))
      }

      const first = await backfill.backfillResourceLinkS3Key({ write: true })

      expect(first.results).toEqual({ written: 5 })
      expect(first.categories).toEqual({
        consistent: 2,
        single: 2,
        missing: 1
      })
      expect(first.remaining).toBe(0)
      const links = await prisma.patch_resource_link.findMany({
        where: { resource: { patch_id: P } },
        select: { content: true, s3_key: true, storage: true },
        orderBy: { id: 'asc' }
      })
      expect(links.map((link) => link.s3_key)).toEqual([
        shared,
        shared,
        crossPatch,
        resolvedOnly,
        dead,
        keyed,
        ''
      ])

      // 现行 (收窄后) 的谓词不能把回填前在用的对象判成无引用
      for (const key of keys) {
        if (before.get(key) && existingObjects.has(key)) {
          expect({ key, narrowed: await narrowedReferenced(key) }).toEqual({
            key,
            narrowed: true
          })
        }
      }
      // 自检: 回填前确实有在用的历史对象被收窄前的谓词认领, 上面的循环不是空转
      expect(before.get(shared)).toBe(true)
      expect(before.get(crossPatch)).toBe(true)
      // 只按 hash 还原的那个对象此前没有声明的持有者, 回填后有了 (只会多保护, 不会少)
      expect(before.get(resolvedOnly)).toBe(false)
      expect(await narrowedReferenced(resolvedOnly)).toBe(true)
      expect(await narrowedReferenced(external)).toBe(false)

      const second = await backfill.backfillResourceLinkS3Key({ write: true })
      expect(second.scanned).toBe(0)
      expect(second.remaining).toBe(0)
    })
  }
)
