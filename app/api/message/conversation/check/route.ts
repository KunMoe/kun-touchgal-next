import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { createConversationSchema } from '~/validations/conversation'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { checkConversation } from '../service'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, createConversationSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await checkConversation(input, payload)
  return NextResponse.json(response)
}
