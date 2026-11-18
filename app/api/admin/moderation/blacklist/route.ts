import { NextRequest, NextResponse } from 'next/server'
import {
  kunParseDeleteQuery,
  kunParsePostBody
} from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { formatModerationContentTypeLabel } from '~/constants/moderation'
import { prisma } from '~/prisma/index'
import {
  adminModerationBlacklistCreateSchema,
  adminModerationBlacklistDeleteSchema
} from '~/validations/admin'
import { can } from '~/constants/permission'
import type { AdminModerationBlacklistItem } from '~/types/api/admin'

const verifyAdmin = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return '用户未登录'
  }
  if (!can(payload, 'admin.access')) {
    return '本页面仅超级管理员可访问'
  }
  return payload
}

export const GET = async (req: NextRequest) => {
  const payload = await verifyAdmin(req)
  if (typeof payload === 'string') {
    return NextResponse.json(payload)
  }

  const data = await prisma.moderation_blacklist.findMany({
    orderBy: { created: 'desc' },
    include: {
      user: {
        select: { id: true, name: true, avatar: true }
      }
    }
  })

  const items: AdminModerationBlacklistItem[] = data.map((item) => ({
    id: item.id,
    pattern: item.pattern,
    contentTypes: item.content_types,
    user: item.user,
    created: item.created
  }))

  return NextResponse.json({ items })
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(
    req,
    adminModerationBlacklistCreateSchema
  )
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyAdmin(req)
  if (typeof payload === 'string') {
    return NextResponse.json(payload)
  }

  const duplicated = await prisma.moderation_blacklist.findFirst({
    where: { pattern: input.pattern }
  })
  if (duplicated) {
    return NextResponse.json('该模式已在黑名单中')
  }

  const typeLabel = formatModerationContentTypeLabel(input.contentTypes)
  await prisma.$transaction(async (tx) => {
    await tx.moderation_blacklist.create({
      data: {
        pattern: input.pattern,
        content_types: input.contentTypes,
        user_id: payload.uid
      }
    })
    await tx.admin_log.create({
      data: {
        type: 'create',
        user_id: payload.uid,
        content: `管理员添加了审核黑名单模式: ${input.pattern} (生效类型: ${typeLabel})`
      }
    })
  })

  return NextResponse.json({})
}

export const DELETE = async (req: NextRequest) => {
  const input = kunParseDeleteQuery(req, adminModerationBlacklistDeleteSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyAdmin(req)
  if (typeof payload === 'string') {
    return NextResponse.json(payload)
  }

  const item = await prisma.moderation_blacklist.findUnique({
    where: { id: input.blacklistId }
  })
  if (!item) {
    return NextResponse.json('未找到该黑名单模式')
  }

  await prisma.$transaction(async (tx) => {
    await tx.moderation_blacklist.delete({ where: { id: item.id } })
    await tx.admin_log.create({
      data: {
        type: 'delete',
        user_id: payload.uid,
        content: `管理员删除了审核黑名单模式: ${item.pattern}`
      }
    })
  })

  return NextResponse.json({})
}
