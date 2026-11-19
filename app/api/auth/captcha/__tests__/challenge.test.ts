import { describe, expect, it, vi } from 'vitest'

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

import { POST } from '~/app/api/auth/captcha/challenge/route'

// 刻意不 mock capjs-core: 0.1.9 起其默认签发 format 2 (HashWX), 而 redeem 只接受
// format 1 的数字答案; 只有真实调用 generateChallenge 才测得出签发格式漂移
describe('captcha challenge route', () => {
  it('签发 format 1 挑战 (c=50, s=32, d=4)', async () => {
    process.env.KUN_CAP_SECRET = 'test-secret-test-secret-test-secret'

    const request = new Request('http://localhost/api/auth/captcha/challenge', {
      method: 'POST'
    }) as unknown as Parameters<typeof POST>[0]
    const body = await (await POST(request)).json()

    expect(body.challenge).toEqual({ c: 50, s: 32, d: 4 })
    expect(body).not.toHaveProperty('format')
    expect(body).not.toHaveProperty('challenges')
    expect(typeof body.token).toBe('string')
    expect(body.expires).toBeGreaterThan(Date.now())
  })
})
