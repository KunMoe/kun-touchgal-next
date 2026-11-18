import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery, kunParsePutBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import {
  adminAppealPaginationSchema,
  adminHandleAppealSchema
} from '~/validations/admin'
import { getAppeals } from './get'
import { handleAppeal } from './handle'
import { can } from '~/constants/permission'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, adminAppealPaginationSchema)
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

  const response = await getAppeals(input)
  return NextResponse.json(response)
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, adminHandleAppealSchema)
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

  const response = await handleAppeal(input, payload.uid)
  return NextResponse.json(response)
}
