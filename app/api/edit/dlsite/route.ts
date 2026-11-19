import { NextResponse } from 'next/server'
import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { fetchDlsiteData } from '~/lib/arnebiae/dlsite'

const dlsiteSchema = z.object({
  code: z.string().regex(/^(RJ|VJ)\d+$/i, 'DLSite Code 格式不正确')
})

export const POST = kunRoute.post({
  auth: 'user',
  input: dlsiteSchema,
  handler: async ({ input }) => {
    try {
      const data = await fetchDlsiteData(input.code)
      return NextResponse.json(data)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('DLSite fetch failed', { code: input.code, error })
      return NextResponse.json('DLSite API 请求失败, 请稍后重试')
    }
  }
})
