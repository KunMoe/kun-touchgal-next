import { NextRequest, NextResponse } from 'next/server'
import {
  kunParseDeleteQuery,
  kunParseGetQuery,
  kunParsePostBody,
  kunParsePutBody
} from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import {
  patchCommentCreateSchema,
  patchCommentUpdateSchema,
  getPatchCommentSchema
} from '~/validations/patch'
import { getPatchComment } from './get'
import { createPatchComment } from './create'
import { updateComment } from './update'
import { deleteComment } from './delete'
import * as z from 'zod'

const commentIdSchema = z.object({
  commentId: z.coerce
    .number({ message: '评论 ID 必须为数字' })
    .min(1)
    .max(9999999)
})

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getPatchCommentSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户登录失效')
  }

  const response = await getPatchComment(input, payload)
  return NextResponse.json(response)
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, patchCommentCreateSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await createPatchComment(input, payload.uid, payload.role)
  return NextResponse.json(response)
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, patchCommentUpdateSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await updateComment(input, payload.uid, payload.role)
  return NextResponse.json(response)
}

export const DELETE = async (req: NextRequest) => {
  const input = kunParseDeleteQuery(req, commentIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await deleteComment(input, payload.uid, payload.role)
  return NextResponse.json(response)
}
