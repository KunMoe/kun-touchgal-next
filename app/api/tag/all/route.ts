import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { getTagSchema } from '~/validations/tag'
import { getTag } from './service'
import { getAuthenticatedBlockedTagIds } from '~/app/api/utils/getBlockedTagIds'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getTagSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const blockedTagIds = await getAuthenticatedBlockedTagIds(req)
  if (!blockedTagIds) {
    return NextResponse.json('用户未登录')
  }
  const response = await getTag(input, blockedTagIds)
  return NextResponse.json(response)
}
