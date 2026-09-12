import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { getMessageSchema } from '~/validations/message'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { getMessage } from './service'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getMessageSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await getMessage(input, payload.uid)
  return NextResponse.json(response)
}
