import { NextRequest, NextResponse } from 'next/server'
import {
  kunParseDeleteQuery,
  kunParseGetQuery,
  kunParsePutBody
} from '~/app/api/utils/parseQuery'
import {
  adminDeleteResourceSchema,
  adminResourcePaginationSchema
} from '~/validations/admin'
import { getNSFWHeader } from '~/app/api/utils/getNSFWHeader'
import { getPatchResource } from './get'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { patchResourceUpdateSchema } from '~/validations/patch'
import { updatePatchResource } from './update'
import { deleteResource } from './delete'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, adminResourcePaginationSchema)
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
  const nsfwEnable = await getNSFWHeader(req, payload)

  const res = await getPatchResource(input, nsfwEnable)
  return NextResponse.json(res)
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, patchResourceUpdateSchema)
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

  const response = await updatePatchResource(input, payload.uid, payload.role)
  return NextResponse.json(response)
}

export const DELETE = async (req: NextRequest) => {
  const input = kunParseDeleteQuery(req, adminDeleteResourceSchema)
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

  const response = await deleteResource(input, payload.uid)
  return NextResponse.json(response)
}
