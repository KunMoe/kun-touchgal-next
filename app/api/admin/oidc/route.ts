import { NextResponse } from 'next/server'
import { can } from '~/constants/permission'
import type { NextRequest } from 'next/server'
import {
  kunParseDeleteQuery,
  kunParsePostBody,
  kunParsePutBody
} from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import {
  oidcClientCreateSchema,
  oidcClientDeleteSchema,
  oidcClientUpdateSchema
} from '~/validations/oidc'
import {
  createOidcClient,
  deleteOidcClient,
  getOidcClients,
  updateOidcClient
} from './service'

const ensureAdmin = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return '用户未登录'
  }
  if (!can(payload, 'admin.access')) {
    return '本页面仅超级管理员可访问'
  }
  return null
}

export const GET = async (req: NextRequest) => {
  const error = await ensureAdmin(req)
  if (error) {
    return NextResponse.json(error)
  }
  return NextResponse.json(await getOidcClients())
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, oidcClientCreateSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const error = await ensureAdmin(req)
  if (error) {
    return NextResponse.json(error)
  }
  return NextResponse.json(await createOidcClient(input))
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, oidcClientUpdateSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const error = await ensureAdmin(req)
  if (error) {
    return NextResponse.json(error)
  }
  return NextResponse.json(await updateOidcClient(input))
}

export const DELETE = async (req: NextRequest) => {
  const input = kunParseDeleteQuery(req, oidcClientDeleteSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const error = await ensureAdmin(req)
  if (error) {
    return NextResponse.json(error)
  }
  return NextResponse.json(await deleteOidcClient(input.id))
}
