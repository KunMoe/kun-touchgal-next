import { NextRequest, NextResponse } from 'next/server'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { adminUpdateDisableRegisterSchema } from '~/validations/admin'
import { delKv, setKv } from '~/lib/redis'
import { KUN_PATCH_DISABLE_REGISTER_KEY } from '~/config/redis'
import { getDisableRegisterStatus } from './service'

export const GET = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (payload.role < 4) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const res = await getDisableRegisterStatus()
  return NextResponse.json(res)
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, adminUpdateDisableRegisterSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (payload.role < 4) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  if (input.disableRegister) {
    await setKv(KUN_PATCH_DISABLE_REGISTER_KEY, 'true')
  } else {
    await delKv(KUN_PATCH_DISABLE_REGISTER_KEY)
  }

  return NextResponse.json({})
}
