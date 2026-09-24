import { NextRequest, NextResponse } from 'next/server'
import * as z from 'zod'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { prisma } from '~/prisma/index'
import { gatherAndEnsurePatchCompanies } from '../_gatherCompanies'
import { invalidateCompanyListCache } from '~/app/api/company/cache'
import { invalidatePatchRelationCaches } from '~/app/api/patch/introduction/_relationRoute'
import { queueSearchSync } from '~/server/search/sync'

const fetchCompanySchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999)
})

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, fetchCompanySchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (payload.role < 3) {
    return NextResponse.json('您没有权限执行此操作')
  }

  const patch = await prisma.patch.findUnique({
    where: { id: input.patchId },
    select: {
      unique_id: true,
      vndb_id: true,
      bangumi_id: true,
      steam_id: true,
      dlsite_code: true
    }
  })

  if (!patch) {
    return NextResponse.json('未找到对应的游戏')
  }

  if (
    !patch.vndb_id &&
    !patch.bangumi_id &&
    !patch.steam_id &&
    !patch.dlsite_code
  ) {
    return NextResponse.json('该游戏没有关联任何外部来源')
  }

  const result = await gatherAndEnsurePatchCompanies(
    input.patchId,
    {
      vndbId: patch.vndb_id,
      bangumiId: patch.bangumi_id,
      steamId: patch.steam_id,
      dlsiteCode: patch.dlsite_code
    },
    payload.uid
  )

  if (result.fetched === 0) {
    return NextResponse.json('未能从外部来源获取到会社信息')
  }

  // 非事务多步写入为尽力而为语义（与旧 vndb 路径一致），崩溃窗口由每日对账兜底
  if (result.changed) {
    await invalidatePatchRelationCaches(
      patch.unique_id,
      invalidateCompanyListCache
    )
    // 此处的抓取写入不在事务内入队, 故必须用会 upsert 的 queueSearchSync
    queueSearchSync(input.patchId)
  }

  const companies = await prisma.patch_company.findMany({
    where: {
      patch_relations: {
        some: { patch_id: input.patchId }
      }
    },
    select: {
      id: true,
      name: true,
      count: true
    }
  })

  return NextResponse.json({
    message: `成功关联 ${companies.length} 个会社`,
    companies
  })
}
