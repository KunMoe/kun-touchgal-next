import { NextRequest, NextResponse } from 'next/server'
import * as z from 'zod'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { fetchSteamAppData } from '~/lib/arnebiae/steam'

const steamSchema = z.object({
  steamId: z.string().regex(/^\d+$/, 'Steam ID 必须为纯数字')
})

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, steamSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  try {
    const data = await fetchSteamAppData(Number(input.steamId))
    return NextResponse.json({
      name: data.name,
      aliases: data.aliases,
      releaseDate: data.releaseDate,
      tags: data.tags,
      developers: data.developers
    })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Steam fetch failed', { steamId: input.steamId, error })
    return NextResponse.json('Steam API 请求失败')
  }
}
