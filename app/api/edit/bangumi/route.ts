import { NextResponse } from 'next/server'
import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { BANGUMI_API_BASE, BANGUMI_HEADERS } from '~/constants/bangumi'
import { lowQualityTags } from '~/lib/bgmDirtyTag'
import { extractDevelopers, type BangumiInfoboxItem } from './_developers'

const EXTERNAL_API_TIMEOUT_MS = 10 * 1000

const bangumiSchema = z.object({
  bangumiId: z.string().regex(/^\d+$/, 'Bangumi ID 必须为纯数字')
})

interface BangumiTag {
  name: string
  count: number
}

interface BangumiSubject {
  name?: string
  name_cn?: string
  date?: string
  tags?: BangumiTag[]
  infobox?: BangumiInfoboxItem[]
}

const dirtyTagSet = new Set(lowQualityTags)

export const POST = kunRoute.post({
  auth: 'user',
  input: bangumiSchema,
  abuse: ['external.fetch', 'upstream.bangumi'],
  handler: async ({ input }) => {
    try {
      const res = await fetch(
        `${BANGUMI_API_BASE}/v0/subjects/${input.bangumiId}`,
        {
          headers: BANGUMI_HEADERS,
          signal: AbortSignal.timeout(EXTERNAL_API_TIMEOUT_MS)
        }
      )
      if (!res.ok) {
        return NextResponse.json('未找到对应的 Bangumi 条目')
      }

      const data = (await res.json()) as BangumiSubject

      const tags = (data.tags ?? [])
        .filter((t) => !dirtyTagSet.has(t.name))
        .map((t) => t.name)

      const developers = extractDevelopers(data.infobox)

      return NextResponse.json({
        name: data.name ?? '',
        nameCn: data.name_cn ?? '',
        released: data.date ?? '',
        tags,
        developers
      })
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Bangumi fetch failed', {
        bangumiId: input.bangumiId,
        error
      })
      return NextResponse.json('Bangumi API 请求失败')
    }
  }
})
