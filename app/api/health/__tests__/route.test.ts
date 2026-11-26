import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

import { GET, dynamic } from '~/app/api/health/route'

const request = new Request(
  'http://localhost/api/health'
) as unknown as Parameters<typeof GET>[0]

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/health', () => {
  it('reports the release the process was started from', async () => {
    vi.stubEnv('KUN_RELEASE_ID', '20261126030405-fc8b626')
    const res = await GET(request)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ release: '20261126030405-fc8b626' })
  })

  it('reports null for a build from the legacy layout', async () => {
    vi.stubEnv('KUN_RELEASE_ID', undefined)
    const res = await GET(request)
    expect(await res.json()).toEqual({ release: null })
  })

  it('is evaluated per request, not frozen at build time', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
