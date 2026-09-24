import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { duplicateSchema, INT4_MAX, INT4_MIN } from '~/validations/edit'
import type { Prisma } from '~/prisma/generated/prisma/client'

// 超出 int4 的值在 patch 表里必然不存在, 原样传给 Prisma 会抛 P2020 冒泡成 500,
// 跳过该条件既安全又不会漏判. 与 create / update 不同, 查重是用户输入即触发的只读
// 探测, 静默跳过比报错合适 —— 真正的提示由提交时的 patchCreateSchema 范围校验给出.
// NaN / 小数 / ±Infinity 一并落到 undefined, 与原先 `if (bangumiId)` 的 falsy 跳过
// 行为一致. 上下界都必须判: duplicateQueryField(10) 的 max(10) 挡不住指数记法,
// `-9e9` 仅 4 字符就解析为低于 int4 下界的整数 -9000000000
const toSearchableInt = (value?: string) => {
  const parsed = value ? Number(value) : undefined
  return parsed !== undefined &&
    Number.isInteger(parsed) &&
    parsed >= INT4_MIN &&
    parsed <= INT4_MAX
    ? parsed
    : undefined
}

const duplicate = async (input: z.infer<typeof duplicateSchema>) => {
  const vndbId = input.vndbId?.toLowerCase()
  const vndbRelationId = input.vndbRelationId?.toLowerCase()
  const bangumiId = toSearchableInt(input.bangumiId)
  const steamId = toSearchableInt(input.steamId)
  const dlsiteCode = input.dlsiteCode?.toUpperCase()
  const title = input.title
  const excludeId = toSearchableInt(input.excludeId)

  const conditions: Prisma.patchWhereInput[] = []

  const hasCompositeVndbKey = Boolean(vndbId && vndbRelationId)

  if (hasCompositeVndbKey) {
    conditions.push({
      AND: [{ vndb_id: vndbId }, { vndb_relation_id: vndbRelationId }]
    })
  }

  if (vndbId && !hasCompositeVndbKey) {
    conditions.push({ vndb_id: vndbId })
  }

  if (vndbRelationId && !hasCompositeVndbKey) {
    conditions.push({ vndb_relation_id: vndbRelationId })
  }

  if (bangumiId) {
    conditions.push({ bangumi_id: bangumiId })
  }

  if (steamId) {
    conditions.push({ steam_id: steamId })
  }

  if (dlsiteCode) {
    conditions.push({ dlsite_code: dlsiteCode })
  }

  if (title) {
    conditions.push({
      name: {
        equals: title,
        mode: 'insensitive'
      }
    })
    conditions.push({
      alias: {
        some: {
          name: {
            equals: title,
            mode: 'insensitive'
          }
        }
      }
    })
  }

  if (!conditions.length) {
    return {}
  }

  const where: Prisma.patchWhereInput = {
    OR: conditions
  }

  if (excludeId) {
    where.id = { not: excludeId }
  }

  const patch = await prisma.patch.findFirst({
    where,
    select: {
      unique_id: true
    }
  })

  if (patch?.unique_id) {
    return { uniqueId: patch.unique_id }
  }

  return {}
}

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, duplicateSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const response = await duplicate(input)
  return NextResponse.json(response)
}
