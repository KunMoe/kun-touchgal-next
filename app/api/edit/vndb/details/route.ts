import { NextRequest, NextResponse } from 'next/server'
import * as z from 'zod'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { fetchVndbVn } from '~/lib/arnebiae/vndb'
import { TAG_MAP } from '~/lib/tagMap'
import type {
  VNDBDetailResult,
  VndbTag,
  VndbProducer
} from '~/lib/arnebiae/vndb'

const detailsSchema = z.object({
  vndbId: z.string().regex(/^v\d+$/i, 'VNDB ID 格式不正确')
})

interface VNDBFullResult extends VNDBDetailResult {
  tags?: VndbTag[] | null
  developers?: VndbProducer[] | null
}

const buildAllTitles = (response: { results: VNDBFullResult[] }) => {
  return response.results.flatMap((vn) => {
    const jaTitle = vn.titles.find((t) => t.lang === 'ja')?.title
    const titlesArray = [
      ...(jaTitle ? [jaTitle] : []),
      vn.title,
      ...vn.titles.filter((t) => t.lang !== 'ja').map((t) => t.title),
      ...vn.aliases
    ]
    return titlesArray
  })
}

const buildTags = (results: VNDBFullResult[]) => {
  const allTags = results.flatMap((vn) => vn.tags ?? [])
  return allTags
    .filter(
      (t) =>
        !t.lie &&
        t.spoiler === 0 &&
        (t.category === 'cont' || t.category === 'tech')
    )
    .map((t) => TAG_MAP[t.name] || t.name)
    .filter((name, i, arr) => arr.indexOf(name) === i)
}

const buildDevelopers = (results: VNDBFullResult[]) => {
  const allDevs = results.flatMap((vn) => vn.developers ?? [])
  return allDevs
    .filter(
      (d) => d.name && (d.type === 'co' || d.type === 'ng' || d.type === 'in')
    )
    .map((d) => d.name!)
    .filter((name, i, arr) => arr.indexOf(name) === i)
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, detailsSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const vndbId = input.vndbId.toLowerCase()

  try {
    const vndbData = await fetchVndbVn<VNDBFullResult>(
      ['id', '=', vndbId],
      'title, titles.lang, titles.title, aliases, released, tags{id,name,rating,spoiler,lie,category}, developers{id,name,original,aliases,lang,type}'
    )
    if (!vndbData.results.length) {
      return NextResponse.json('未找到对应的 VNDB 条目')
    }

    const titles = buildAllTitles(vndbData)
    const released = vndbData.results[0].released
    const tags = buildTags(vndbData.results)
    const developers = buildDevelopers(vndbData.results)

    return NextResponse.json({ titles, released, tags, developers })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('VNDB vn fetch failed', { vndbId, error })
    return NextResponse.json('VNDB API 请求失败')
  }
}
