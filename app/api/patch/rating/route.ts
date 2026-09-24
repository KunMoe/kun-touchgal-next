import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import {
  kunParseDeleteQuery,
  kunParseGetQuery,
  kunParsePostBody,
  kunParsePutBody
} from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import {
  patchRatingCreateSchema,
  patchRatingUpdateSchema
} from '~/validations/patch'
import { getPatchRating, getPatchRatingSchema } from './get'
import { createPatchRating } from './create'
import { updatePatchRating } from './update'
import { deletePatchRating } from './delete'

const ratingIdSchema = z.object({
  ratingId: z.coerce
    .number({ message: 'patch rating ID 不正确' })
    .min(1)
    .max(9999999)
})

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getPatchRatingSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await getPatchRating(input, payload)
  return NextResponse.json(response)
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, patchRatingCreateSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await createPatchRating(input, payload.uid, payload.role)
  return NextResponse.json(response)
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, patchRatingUpdateSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await updatePatchRating(input, payload.uid, payload.role)
  return NextResponse.json(response)
}

export const DELETE = async (req: NextRequest) => {
  const input = kunParseDeleteQuery(req, ratingIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await deletePatchRating(input, payload.uid, payload.role)
  return NextResponse.json(response)
}
