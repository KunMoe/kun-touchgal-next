import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery, kunParsePostBody } from '~/app/api/utils/parseQuery'
import {
  getConversationsSchema,
  createConversationSchema
} from '~/validations/conversation'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { getConversations, getOrCreateConversation } from './service'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getConversationsSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await getConversations(input, payload.uid)
  return NextResponse.json(response)
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, createConversationSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await getOrCreateConversation(
    input,
    payload.uid,
    payload.role
  )
  return NextResponse.json(response)
}
