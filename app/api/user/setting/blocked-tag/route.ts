import { NextRequest, NextResponse } from 'next/server'
import {
  kunParseDeleteQuery,
  kunParsePostBody
} from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { blockedTagSchema } from '~/validations/user'
import {
  appendBlockedTagId,
  MAX_BLOCKED_TAG_IDS,
  removeBlockedTagId
} from '~/utils/blockedTag'
import { invalidateUserSession } from '~/app/api/user/session/cache'

const getBlockedTags = async (uid: number) => {
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { blocked_tag_ids: true }
  })
  if (!user) {
    return '未找到用户'
  }
  if (!user.blocked_tag_ids.length) {
    return []
  }

  const tags = await prisma.patch_tag.findMany({
    where: { id: { in: user.blocked_tag_ids } },
    select: {
      id: true,
      name: true,
      count: true,
      alias: true
    }
  })

  const tagMap = new Map(tags.map((tag) => [tag.id, tag]))

  return user.blocked_tag_ids.map((id) => tagMap.get(id)).filter((tag) => !!tag)
}

const addBlockedTag = async (uid: number, tagId: number) => {
  const [user, tag] = await Promise.all([
    prisma.user.findUnique({
      where: { id: uid },
      select: { blocked_tag_ids: true }
    }),
    prisma.patch_tag.findUnique({
      where: { id: tagId },
      select: { id: true }
    })
  ])

  if (!user) {
    return '未找到用户'
  }
  if (!tag) {
    return '未找到标签'
  }

  const blockedTagIds = appendBlockedTagId(user.blocked_tag_ids, tagId)
  // 闸门放在 append 之后并用 >: append 对已屏蔽的 id 返回原数组、长度不变,
  // 满额时重复屏蔽同一标签因而保持幂等成功
  if (blockedTagIds.length > MAX_BLOCKED_TAG_IDS) {
    return `最多只能屏蔽 ${MAX_BLOCKED_TAG_IDS} 个标签`
  }

  const updatedUser = await prisma.user.update({
    where: { id: uid },
    data: {
      blocked_tag_ids: {
        set: blockedTagIds
      }
    },
    select: {
      blocked_tag_ids: true
    }
  })
  await invalidateUserSession(uid)

  return { blockedTagIds: updatedUser.blocked_tag_ids }
}

const deleteBlockedTag = async (uid: number, tagId: number) => {
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { blocked_tag_ids: true }
  })
  if (!user) {
    return '未找到用户'
  }

  const updatedUser = await prisma.user.update({
    where: { id: uid },
    data: {
      blocked_tag_ids: {
        set: removeBlockedTagId(user.blocked_tag_ids, tagId)
      }
    },
    select: {
      blocked_tag_ids: true
    }
  })
  await invalidateUserSession(uid)

  return { blockedTagIds: updatedUser.blocked_tag_ids }
}

export const GET = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await getBlockedTags(payload.uid)
  return NextResponse.json(response)
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, blockedTagSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await addBlockedTag(payload.uid, input.tagId)
  return NextResponse.json(response)
}

export const DELETE = async (req: NextRequest) => {
  const input = kunParseDeleteQuery(req, blockedTagSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await deleteBlockedTag(payload.uid, input.tagId)
  return NextResponse.json(response)
}
