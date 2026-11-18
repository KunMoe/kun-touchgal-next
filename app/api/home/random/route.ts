import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '~/prisma/index'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { toPatchWhere } from '~/server/viewer/patchVisibility'
import type { Prisma } from '~/prisma/generated/prisma/client'

const getRandomUniqueId = async (visibilityWhere: Prisma.patchWhereInput) => {
  const count = await prisma.patch.count({ where: visibilityWhere })
  if (count === 0) {
    return '未查询到文章'
  }

  // 只取 id 使 OFFSET 走 (content_limit, id) 索引的 Index Only Scan;
  // 直接取 unique_id 会对被跳过的行逐行回表, 退化为全表扫描 + 排序
  const [randomPatch] = await prisma.patch.findMany({
    where: visibilityWhere,
    orderBy: { id: 'asc' },
    skip: Math.floor(Math.random() * count),
    take: 1,
    select: { id: true }
  })
  const found = randomPatch
    ? await prisma.patch.findUnique({
        where: { id: randomPatch.id },
        select: { unique_id: true }
      })
    : null
  const patch =
    found ??
    (await prisma.patch.findFirst({
      where: visibilityWhere,
      orderBy: { id: 'asc' },
      select: { unique_id: true }
    }))

  return patch ? { uniqueId: patch.unique_id } : '未查询到文章'
}

export const GET = async (req: NextRequest) => {
  const visibility = await viewerContextFromRequest(req).visibility()

  const response = await getRandomUniqueId(toPatchWhere(visibility))
  return NextResponse.json(response)
}
