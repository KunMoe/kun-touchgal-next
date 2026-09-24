import { NextRequest, NextResponse } from 'next/server'
import * as z from 'zod'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { fetchVndbRelease } from '~/lib/arnebiae/vndb'

const relationSchema = z.object({
  relationId: z.string().regex(/^r\d+$/i, 'Relation ID 格式不正确')
})

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, relationSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const relationId = input.relationId.toLowerCase()

  try {
    const data = await fetchVndbRelease(
      ['id', '=', relationId],
      'id, title, alttitle, released, vns.id'
    )

    if (!data.results.length) {
      return NextResponse.json('未找到对应的 VNDB Release')
    }

    const release = data.results[0]

    if (!release.vns?.length) {
      return NextResponse.json('未能找到关联的 VN ID')
    }

    const vndbId = release.vns[0].id.toLowerCase()

    const titles: string[] = []
    if (release.title) {
      titles.push(release.title)
    }
    if (release.alttitle && !titles.includes(release.alttitle)) {
      titles.push(release.alttitle)
    }

    return NextResponse.json({
      vndbId,
      titles,
      released: release.released ?? ''
    })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('VNDB release fetch failed', { relationId, error })
    return NextResponse.json('VNDB Release API 请求失败')
  }
}
