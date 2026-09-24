import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import {
  createFavoriteFolderSchema,
  updateFavoriteFolderSchema
} from '~/validations/user'
import {
  kunParseDeleteQuery,
  kunParseGetQuery,
  kunParsePostBody,
  kunParsePutBody
} from '~/app/api/utils/parseQuery'
import { getFolders } from './get'
import { updateFolder } from './update'
import { createFolder } from './create'
import { deleteFolder } from './delete'

const folderIdSchema = z.object({
  folderId: z.coerce.number().min(1).max(9999999)
})

const patchIdSchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999).optional(),
  page: z.coerce.number().min(1).max(9999999).optional(),
  limit: z.coerce.number().min(1).max(100).optional()
})

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, patchIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const res = await getFolders(input, payload.uid, payload.uid)
  return NextResponse.json(res)
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, createFavoriteFolderSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const res = await createFolder(input, payload.uid)
  return NextResponse.json(res)
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, updateFavoriteFolderSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await updateFolder(input, payload.uid)
  return NextResponse.json(response)
}

export const DELETE = async (req: NextRequest) => {
  const input = kunParseDeleteQuery(req, folderIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const res = await deleteFolder(input, payload.uid)
  return NextResponse.json(res)
}
