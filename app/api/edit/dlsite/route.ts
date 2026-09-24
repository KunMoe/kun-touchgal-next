import { NextRequest, NextResponse } from 'next/server'
import * as z from 'zod'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { fetchDlsiteData } from '~/lib/arnebiae/dlsite'

const dlsiteSchema = z.object({
  code: z.string().regex(/^(RJ|VJ)\d+$/i, 'DLSite Code 格式不正确')
})

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, dlsiteSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  try {
    const data = await fetchDlsiteData(input.code)
    return NextResponse.json(data)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('DLSite fetch failed', { code: input.code, error })
    return NextResponse.json('DLSite API 请求失败, 请稍后重试')
  }
}
