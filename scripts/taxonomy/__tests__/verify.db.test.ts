import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { kunConnect } from '~/scripts/db/lib/runtime'
import { verifyResourceTaxonomy } from '~/scripts/taxonomy/lib/verify'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'
import type { TaxonomyReport } from '~/scripts/taxonomy/lib/verify'

// 核查的两条扫描语句在真实 PostgreSQL 上的行为 (运行方式见 server/db/__tests__/dbContract.ts)。
// 单测里的假客户端不看 SQL 文本: 漏写 ORDER BY、游标写成 >=、JOIN 里多带一个 status 条件
// 都照样通过, 而它们分别会漏行、重复计数、让隐藏的资源逃过核查。
// 两张表的行数都超过一批 (2000), 违规行压在批的边界两侧; 前 1000 行在插入后被更新过
// 一次, 新版本排到堆的末尾, 物理顺序与 id 顺序不同
const TOTAL = 2500

describe.skipIf(!dbContractUrl)(
  'verifyResourceTaxonomy on real PostgreSQL',
  () => {
    let prisma: Awaited<ReturnType<typeof openDbContract>>
    let userId: number
    let patchIds: number[]
    let resourceIds: number[]
    let report: TaxonomyReport

    beforeAll(async () => {
      prisma = await openDbContract()
      const [user] = await prisma.$queryRaw<{ id: number }[]>`
        INSERT INTO "user" (name, email, password, updated)
        VALUES ('t44-verify', 't44-verify@example.com', 'x', now())
        RETURNING id`
      userId = user.id

      const patches = await prisma.$queryRaw<{ id: number }[]>`
        INSERT INTO patch (unique_id, name, user_id, updated, type, language, platform)
        SELECT 'v' || lpad(n::text, 7, '0'), 't44', ${userId}, now(),
               '{game}', '{zh-Hans}', '{windows}'
          FROM generate_series(1, ${TOTAL}) AS n
        RETURNING id`
      patchIds = patches.map((patch) => patch.id).sort((a, b) => a - b)
      await prisma.$executeRaw`
        UPDATE patch SET name = name WHERE id <= ${patchIds[999]}`
      // 第一批的最后一行带旧值 (status 不是 0 的作品照样核查), 第二批的第一行三列都是 NULL
      await prisma.$executeRaw`
        UPDATE patch
           SET type = '{chinese,patch}', platform = '{android}', status = 1
         WHERE id = ${patchIds[1999]}`
      await prisma.$executeRaw`
        UPDATE patch SET type = NULL, language = NULL, platform = NULL
         WHERE id = ${patchIds[2000]}`

      // emulator_type 不给值, 落库是 NULL: 与加列之前的存量行一样
      const resources = await prisma.$queryRaw<{ id: number }[]>`
        INSERT INTO patch_resource
          (section, user_id, patch_id, updated, type, language, platform, model_name)
        SELECT 'galgame', ${userId}, ${patchIds[0]}, now(),
               '{game}', '{zh-Hans}', '{windows}', ''
          FROM generate_series(1, ${TOTAL})
        RETURNING id`
      resourceIds = resources.map((row) => row.id).sort((a, b) => a - b)

      await prisma.$executeRaw`
        UPDATE patch_resource SET model_name = model_name
         WHERE id <= ${resourceIds[999]}`
      await prisma.$executeRaw`
        UPDATE patch_resource SET type = '{chinese,pc}'
         WHERE id = ${resourceIds[10]}`
      // 第一批的最后一行: 隐藏的资源, 旧平台值
      await prisma.$executeRaw`
        UPDATE patch_resource SET platform = '{android}', status = 1
         WHERE id = ${resourceIds[1999]}`
      // 第二批的第一行
      await prisma.$executeRaw`
        UPDATE patch_resource SET type = '{pc}'
         WHERE id = ${resourceIds[2000]}`
      await prisma.$executeRaw`
        UPDATE patch_resource SET platform = NULL
         WHERE id = ${resourceIds[TOTAL - 1]}`

      const client = await kunConnect(dbContractUrl, 'KUN_DB_CONTRACT_URL', {
        readOnly: true
      })
      try {
        report = await verifyResourceTaxonomy(client)
      } finally {
        await client.end()
      }
    })

    afterAll(async () => {
      await prisma.$executeRaw`
        DELETE FROM patch_resource WHERE user_id = ${userId}`
      await prisma.$executeRaw`DELETE FROM patch WHERE user_id = ${userId}`
      await prisma.$executeRaw`DELETE FROM "user" WHERE id = ${userId}`
      await prisma.$disconnect()
    })

    it('每一行恰好读到一次, 批的边界两侧都不漏不重', () => {
      expect(report.resources).toMatchObject({
        scanned: TOTAL,
        clean: TOTAL - 4,
        blockingRows: 3,
        blockingIds: [resourceIds[10], resourceIds[1999], resourceIds[2000]],
        otherRows: 1,
        otherOnlyRows: 1
      })
    })

    // resourceIds[1999] 是夹具里隐藏 (status = 1) 的那一行
    it('不分 status: 隐藏的资源照样核查', () => {
      expect(report.resources.blockingIds).toContain(resourceIds[1999])
    })

    it('每一行带上所属作品的 unique_id 与它带着的值', () => {
      expect(report.resources.blocking.get('平台含词表外的值')?.rows).toEqual([
        {
          id: resourceIds[1999],
          path: `/v0000001/resource/${resourceIds[1999]}`,
          values: ['android']
        }
      ])
      // 两批各一行: 列出来的行不止第一批的
      expect(report.resources.blocking.get('类型含词表外的值')?.rows).toEqual([
        {
          id: resourceIds[10],
          path: `/v0000001/resource/${resourceIds[10]}`,
          values: ['chinese', 'pc']
        },
        {
          id: resourceIds[2000],
          path: `/v0000001/resource/${resourceIds[2000]}`,
          values: ['pc']
        }
      ])
    })

    it('派生列: 词表外的值拦收尾, 整列为 NULL 的作品算干净', () => {
      expect(report.patches).toMatchObject({
        scanned: TOTAL,
        blockingRows: 1,
        blockingIds: [patchIds[1999]]
      })
      expect(
        Object.fromEntries(
          [...report.patches.blocking].map(([label, tally]) => [
            label,
            Object.fromEntries(tally.values)
          ])
        )
      ).toEqual({
        'patch.type 含词表外的值': { chinese: 1, patch: 1 },
        'patch.platform 含词表外的值': { android: 1 }
      })
    })
  }
)
