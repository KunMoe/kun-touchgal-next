import { NextRequest, NextResponse } from 'next/server'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { adminUpdateModerationSettingSchema } from '~/validations/admin'
import { delKv, setKv } from '~/lib/redis'
import {
  KUN_MODERATION_DRY_RUN_KEY,
  KUN_MODERATION_ENABLED_KEY
} from '~/config/redis'
import { prisma } from '~/prisma/index'
import { clearModerationConfigCache } from '~/server/moderation/config'
import { getModerationSetting } from './service'
import { can } from '~/constants/permission'

export const GET = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const res = await getModerationSetting()
  return NextResponse.json(res)
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, adminUpdateModerationSettingSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const admin = await prisma.user.findUnique({ where: { id: payload.uid } })
  if (!admin) {
    return NextResponse.json('未找到该管理员')
  }

  const previous = await getModerationSetting()

  if (input.enabled) {
    await setKv(KUN_MODERATION_ENABLED_KEY, 'true')
  } else {
    await delKv(KUN_MODERATION_ENABLED_KEY)
  }
  if (input.dryRun) {
    await setKv(KUN_MODERATION_DRY_RUN_KEY, 'true')
  } else {
    await delKv(KUN_MODERATION_DRY_RUN_KEY)
  }
  clearModerationConfigCache()

  await prisma.admin_log.create({
    data: {
      type: 'update',
      user_id: payload.uid,
      content: `管理员 ${admin.name} 更新了 AI 审核设置\n启用审核: ${previous.enabled} -> ${input.enabled}\n灰度模式: ${previous.dryRun} -> ${input.dryRun}`
    }
  })

  return NextResponse.json({})
}
