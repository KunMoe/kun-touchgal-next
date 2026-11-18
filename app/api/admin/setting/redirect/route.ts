import { NextRequest, NextResponse } from 'next/server'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { adminUpdateRedirectSchema } from '~/validations/admin'
import { ADMIN_REDIRECT_CONFIG_CACHE_DURATION } from '~/config/cache'
import { setKv } from '~/lib/redis'
import { prisma } from '~/prisma/index'
import {
  ADMIN_REDIRECT_REDIS_KEY,
  ADMIN_REDIRECT_SETTING_KEY,
  getRedirectConfig
} from './getRedirectConfig'
import { invalidateAllUserSessions } from '~/app/api/user/session/cache'
import { can } from '~/constants/permission'

export const GET = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const config = await getRedirectConfig()
  return NextResponse.json(config)
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, adminUpdateRedirectSchema)
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

  // 事实源写穿 admin_setting 表, Redis 仅作缓存 (volatile-lfu 下带 TTL 的键会被驱逐)
  await prisma.admin_setting.upsert({
    where: { key: ADMIN_REDIRECT_SETTING_KEY },
    create: { key: ADMIN_REDIRECT_SETTING_KEY, value: input },
    update: { value: input }
  })
  await setKv(
    ADMIN_REDIRECT_REDIS_KEY,
    JSON.stringify(input),
    ADMIN_REDIRECT_CONFIG_CACHE_DURATION
  )
  await invalidateAllUserSessions()
  return NextResponse.json({})
}
