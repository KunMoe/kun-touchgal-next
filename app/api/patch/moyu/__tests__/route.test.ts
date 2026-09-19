import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { getMoyuPatchResourcesMock } = vi.hoisted(() => ({
  getMoyuPatchResourcesMock: vi.fn()
}))

vi.mock('../service', () => ({
  getMoyuPatchResources: getMoyuPatchResourcesMock
}))

import { GET } from '../route'

const request = (query: string) =>
  new NextRequest(`http://localhost/api/patch/moyu?${query}`)

describe('GET /api/patch/moyu', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it.each(['vndbId=', 'vndbId=4145', 'vndbId=v1,vndb:v2', 'vndbId=V4145', ''])(
    '非法 vndbId (%s) 被拒且不调用 service',
    async (query) => {
      const res = await GET(request(query))

      expect(typeof (await res.json())).toBe('string')
      expect(getMoyuPatchResourcesMock).not.toHaveBeenCalled()
    }
  )

  it('合法 vndbId 透传 service 结果', async () => {
    getMoyuPatchResourcesMock.mockResolvedValue([])

    const res = await GET(request('vndbId=v4145'))

    expect(await res.json()).toEqual([])
    expect(getMoyuPatchResourcesMock).toHaveBeenCalledWith('v4145')
  })
})
