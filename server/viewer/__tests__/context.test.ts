import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

const {
  verifyKunTokenWithUserMock,
  hasPendingResourceMock,
  headersMock,
  cookiesMock,
  renderCache
} = vi.hoisted(() => ({
  verifyKunTokenWithUserMock: vi.fn(),
  hasPendingResourceMock: vi.fn(),
  headersMock: vi.fn(),
  cookiesMock: vi.fn(),
  renderCache: new Map<unknown, unknown>()
}))

vi.mock('~/app/api/utils/jwt', () => ({
  verifyKunTokenWithUser: verifyKunTokenWithUserMock
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  hasPendingResource: hasPendingResourceMock
}))

vi.mock('next/headers', () => ({
  headers: headersMock,
  cookies: cookiesMock
}))

// 一次渲染 = 一个 renderCache: 同一个无参函数只执行一次
vi.mock('react', () => ({
  cache:
    <Result>(fn: () => Result) =>
    (): Result => {
      if (!renderCache.has(fn)) {
        renderCache.set(fn, fn())
      }
      return renderCache.get(fn) as Result
    }
}))

import { createViewerContext } from '~/server/viewer/context'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getViewerContext } from '~/server/viewer/fromHeaders'
import { verifyHeaderCookie as verifyRequestCookie } from '~/middleware/_verifyHeaderCookie'
import { verifyHeaderCookie as verifyRenderCookie } from '~/utils/actions/verifyHeaderCookie'

const TOKEN = 'kun-galgame-patch-moe-token'
const NSFW = 'kun-patch-setting-store|state|data|kunNsfwEnable'
const MIRROR = 'kun-patch-setting-store|state|data|kunBlockedTagIds'

const DB_BLOCKED = [10, 20]

const sessionOf = (role: number, blocked: number[] = DB_BLOCKED) => ({
  payload: { iss: '', aud: '', jti: 'j', uid: 7, name: 'kun', role },
  user: { id: 7, name: 'kun', role, status: 0, blocked_tag_ids: blocked }
})

// 只有 'good' 这个 token 对应一个有效会话; blocked 是库里的屏蔽列表
const useSession = (role = 1, blocked: number[] = DB_BLOCKED) => {
  verifyKunTokenWithUserMock.mockImplementation(async (token: string) =>
    token === 'good' ? sessionOf(role, blocked) : null
  )
}

const cookieHeader = (cookies: Record<string, string | undefined>) =>
  Object.entries(cookies)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')

beforeEach(() => {
  vi.resetAllMocks()
  renderCache.clear()
  useSession()
  hasPendingResourceMock.mockResolvedValue(false)
})

describe('session / viewer', () => {
  it('没有 token 时是匿名, 不校验会话', async () => {
    const ctx = createViewerContext(cookieHeader({ [NSFW]: 'all' }))

    await expect(ctx.session()).resolves.toEqual({ kind: 'anonymous' })
    await expect(ctx.viewer()).resolves.toBeNull()
    expect(verifyKunTokenWithUserMock).not.toHaveBeenCalled()
  })

  it('空 token 与没有 token 一样', async () => {
    const ctx = createViewerContext(`${TOKEN}=`)

    await expect(ctx.viewer()).resolves.toBeNull()
    expect(verifyKunTokenWithUserMock).not.toHaveBeenCalled()
  })

  it('token 校验不过是匿名', async () => {
    const ctx = createViewerContext(cookieHeader({ [TOKEN]: 'stale' }))

    await expect(ctx.session()).resolves.toEqual({ kind: 'anonymous' })
    await expect(ctx.viewer()).resolves.toBeNull()
  })

  it('有效会话带出 payload 与库里的用户', async () => {
    const ctx = createViewerContext(cookieHeader({ [TOKEN]: 'good' }))

    await expect(ctx.session()).resolves.toEqual({
      kind: 'authenticated',
      ...sessionOf(1)
    })
    await expect(ctx.viewer()).resolves.toEqual(sessionOf(1).payload)
  })

  it('token 按 URI 组件解码后再校验, 畸形转义回落原值', async () => {
    await createViewerContext(`${TOKEN}=a%2Cb`).viewer()
    await createViewerContext(`${TOKEN}=100%`).viewer()

    expect(verifyKunTokenWithUserMock.mock.calls).toEqual([['a,b'], ['100%']])
  })

  it('同一个上下文里并发与先后取用都只校验一次', async () => {
    const ctx = createViewerContext(
      cookieHeader({ [TOKEN]: 'good', [NSFW]: 'all', [MIRROR]: '%2' })
    )

    await Promise.all([
      ctx.session(),
      ctx.viewer(),
      ctx.visibility(),
      ctx.listView(),
      ctx.listView({ personalizedByPendingResource: true })
    ])
    await ctx.visibility()
    await ctx.viewer()

    expect(verifyKunTokenWithUserMock).toHaveBeenCalledTimes(1)
  })

  it('无效 token 也只校验一次', async () => {
    const ctx = createViewerContext(
      cookieHeader({ [TOKEN]: 'stale', [NSFW]: 'all', [MIRROR]: '[1]' })
    )

    await Promise.all([ctx.viewer(), ctx.visibility(), ctx.listView()])

    expect(verifyKunTokenWithUserMock).toHaveBeenCalledTimes(1)
  })
})

describe('visibility', () => {
  const NSFW_CASES = [
    [undefined, 'sfw'],
    ['', 'sfw'],
    ['sfw', 'sfw'],
    ['nsfw', 'nsfw'],
    ['all', null],
    // 可解码但不在枚举里, 以及畸形转义回落的原值, 都按 sfw
    ['al%6Cx', 'sfw'],
    ['%2', 'sfw'],
    ['ALL', 'sfw']
  ] as const

  // 客户端的设置 store 仍会把屏蔽列表写成 cookie; 服务端不读它, 无论里面是什么
  const MIRROR_VALUES = [
    undefined,
    '',
    '[]',
    '[7%2C8]',
    '%5B7%2C8%5D',
    '[7,8]',
    '["1%"]',
    '%2',
    '100%',
    'kun',
    '{"a":1}'
  ] as const

  const TOKEN_CASES = [
    [undefined, false],
    ['', false],
    ['stale', false],
    ['good', true]
  ] as const

  const matrix = TOKEN_CASES.flatMap(([token, authenticated]) =>
    NSFW_CASES.flatMap(([nsfw, contentLimit]) =>
      MIRROR_VALUES.map((mirror) => ({
        header: cookieHeader({
          [TOKEN]: token,
          [NSFW]: nsfw,
          [MIRROR]: mirror
        }),
        expected: authenticated
          ? { contentLimit, blockedTagIds: DB_BLOCKED }
          : { contentLimit: 'sfw', blockedTagIds: [] },
        verifications: token ? 1 : 0
      }))
    )
  )

  // 会话 × 分级设置 × 客户端带来的屏蔽列表副本的全组合: 无效会话一律是公开视角;
  // 有效会话的屏蔽列表恒取鉴权结果, 与那份副本无关
  it(`全组合 ${matrix.length} 例与预期一致, 每例至多校验一次会话`, async () => {
    for (const { header, expected, verifications } of matrix) {
      verifyKunTokenWithUserMock.mockClear()

      const ctx = createViewerContext(`_ga=GA1.2.3; third=%E0%A4%A; ${header}`)

      expect(await ctx.visibility(), header).toEqual(expected)
      expect(verifyKunTokenWithUserMock, header).toHaveBeenCalledTimes(
        verifications
      )
    }
  })

  it('同名 cookie 重复时取最后一个', async () => {
    const ctx = createViewerContext(`${TOKEN}=good; ${NSFW}=all; ${NSFW}=nsfw`)

    await expect(ctx.visibility()).resolves.toEqual({
      contentLimit: 'nsfw',
      blockedTagIds: DB_BLOCKED
    })
  })
})

describe('listView', () => {
  it('游客: shared, sfw', async () => {
    const view = await createViewerContext('').listView({
      personalizedByPendingResource: true
    })

    expect(view).toEqual({
      kind: 'shared',
      visibility: { contentLimit: 'sfw', blockedTagIds: [] }
    })
    expect(hasPendingResourceMock).not.toHaveBeenCalled()
  })

  it.each([
    ['sfw', 'sfw'],
    ['nsfw', 'nsfw'],
    ['all', null]
  ] as const)(
    '普通用户按分级设置 %s 落到各自的共享视角',
    async (nsfw, contentLimit) => {
      useSession(1, [])
      const ctx = createViewerContext(
        cookieHeader({ [TOKEN]: 'good', [NSFW]: nsfw })
      )

      await expect(
        ctx.listView({ personalizedByPendingResource: true })
      ).resolves.toEqual({
        kind: 'shared',
        visibility: { contentLimit, blockedTagIds: [] }
      })
      expect(hasPendingResourceMock).toHaveBeenCalledWith(7)
    }
  )

  it('库里有屏蔽标签: filtered; cookie 里的副本再怎么写也不算', async () => {
    const expected = {
      kind: 'filtered',
      visibility: { contentLimit: 'sfw', blockedTagIds: DB_BLOCKED }
    }

    for (const mirror of [undefined, '[]', '[8%2C7]']) {
      const ctx = createViewerContext(
        cookieHeader({ [TOKEN]: 'good', [MIRROR]: mirror })
      )

      await expect(ctx.listView(), String(mirror)).resolves.toEqual(expected)
      await expect(
        ctx.listView({ personalizedByPendingResource: true }),
        String(mirror)
      ).resolves.toEqual(expected)
    }
  })

  it('库里没有屏蔽标签: cookie 里带着副本也仍是 shared', async () => {
    useSession(1, [])
    const ctx = createViewerContext(
      cookieHeader({ [TOKEN]: 'good', [MIRROR]: '[7%2C8]' })
    )

    await expect(ctx.listView()).resolves.toEqual({
      kind: 'shared',
      visibility: { contentLimit: 'sfw', blockedTagIds: [] }
    })
  })

  it('有待审核资源的作者: 只有声明了 personalizedByPendingResource 才是 personal', async () => {
    useSession(2, [])
    hasPendingResourceMock.mockResolvedValue(true)
    const ctx = createViewerContext(
      cookieHeader({ [TOKEN]: 'good', [NSFW]: 'all' })
    )

    await expect(ctx.listView()).resolves.toEqual({
      kind: 'shared',
      visibility: { contentLimit: null, blockedTagIds: [] }
    })
    expect(hasPendingResourceMock).not.toHaveBeenCalled()

    await expect(
      ctx.listView({ personalizedByPendingResource: true })
    ).resolves.toEqual({
      kind: 'personal',
      visibility: { contentLimit: null, blockedTagIds: [] },
      viewer: sessionOf(2, []).payload
    })
    expect(hasPendingResourceMock).toHaveBeenCalledWith(7)
  })

  it('管理员: personal, 不必查待审核资源; 屏蔽标签照带', async () => {
    useSession(3, [7, 8])
    const ctx = createViewerContext(cookieHeader({ [TOKEN]: 'good' }))

    await expect(
      ctx.listView({ personalizedByPendingResource: true })
    ).resolves.toEqual({
      kind: 'personal',
      visibility: { contentLimit: 'sfw', blockedTagIds: [7, 8] },
      viewer: sessionOf(3, [7, 8]).payload
    })
    expect(hasPendingResourceMock).not.toHaveBeenCalled()

    // 作品列表不含待审核内容: 管理员也只是 filtered
    await expect(ctx.listView()).resolves.toEqual({
      kind: 'filtered',
      visibility: { contentLimit: 'sfw', blockedTagIds: [7, 8] }
    })
  })

  it('会话无效时带着伪造的设置 cookie 也只是游客', async () => {
    hasPendingResourceMock.mockResolvedValue(true)
    const ctx = createViewerContext(
      cookieHeader({ [TOKEN]: 'stale', [NSFW]: 'all', [MIRROR]: '[7%2C8]' })
    )

    await expect(
      ctx.listView({ personalizedByPendingResource: true })
    ).resolves.toEqual({
      kind: 'shared',
      visibility: { contentLimit: 'sfw', blockedTagIds: [] }
    })
    expect(hasPendingResourceMock).not.toHaveBeenCalled()
  })
})

describe('两个适配器', () => {
  const makeReq = (cookie: string | null) =>
    ({
      headers: { get: (key: string) => (key === 'cookie' ? cookie : null) }
    }) as unknown as NextRequest

  it('fromRequest 读请求的 Cookie 头; 没有这个头就是匿名', async () => {
    const req = makeReq(cookieHeader({ [TOKEN]: 'good', [NSFW]: 'nsfw' }))

    await expect(viewerContextFromRequest(req).visibility()).resolves.toEqual({
      contentLimit: 'nsfw',
      blockedTagIds: DB_BLOCKED
    })
    await expect(
      viewerContextFromRequest(makeReq(null)).viewer()
    ).resolves.toBeNull()
  })

  it('Route Handler 侧的 verifyHeaderCookie 返回会话 payload 或 null', async () => {
    await expect(
      verifyRequestCookie(makeReq(`${TOKEN}=good`))
    ).resolves.toEqual(sessionOf(1).payload)
    await expect(
      verifyRequestCookie(makeReq(`${TOKEN}=stale`))
    ).resolves.toBeNull()
    await expect(verifyRequestCookie(makeReq(null))).resolves.toBeNull()
  })

  it('fromHeaders 读原始 Cookie 头 (不经 cookies()), 一次渲染共用一个上下文', async () => {
    headersMock.mockResolvedValue(
      new Headers({
        cookie: cookieHeader({ [TOKEN]: 'good', [MIRROR]: '[7%2C8]' })
      })
    )

    const [first, second] = await Promise.all([
      getViewerContext(),
      getViewerContext()
    ])
    expect(second).toBe(first)

    const [payload, visibility] = await Promise.all([
      verifyRenderCookie(),
      first.visibility()
    ])
    expect(payload).toEqual(sessionOf(1).payload)
    expect(visibility).toEqual({
      contentLimit: 'sfw',
      blockedTagIds: DB_BLOCKED
    })
    expect(headersMock).toHaveBeenCalledTimes(1)
    expect(cookiesMock).not.toHaveBeenCalled()
    expect(verifyKunTokenWithUserMock).toHaveBeenCalledTimes(1)
  })

  it('页面侧没有 Cookie 头时是匿名', async () => {
    headersMock.mockResolvedValue(new Headers())

    await expect(verifyRenderCookie()).resolves.toBeNull()
    expect(verifyKunTokenWithUserMock).not.toHaveBeenCalled()
  })
})
