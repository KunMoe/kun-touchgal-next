import { NextResponse } from 'next/server'
import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { kunLog } from '~/lib/log.server'
import { fetchSteamAppData } from '~/lib/arnebiae/steam'

const steamSchema = z.object({
  steamId: z.string().regex(/^\d+$/, 'Steam ID 必须为纯数字')
})

export const POST = kunRoute.post({
  auth: 'user',
  input: steamSchema,
  abuse: ['external.fetch', 'upstream.steam'],
  handler: async ({ input }) => {
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
      kunLog(
        'external.request_failed',
        { source: 'steam', id: input.steamId },
        error
      )
      return NextResponse.json('Steam API 请求失败')
    }
  }
})
