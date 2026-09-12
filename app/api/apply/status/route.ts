import { NextRequest, NextResponse } from 'next/server'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { getApplyStatus } from './service'

export const GET = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)

  const response = await getApplyStatus(payload?.uid ?? 0)
  return NextResponse.json(response)
}
