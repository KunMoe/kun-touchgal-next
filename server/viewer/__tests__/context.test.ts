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

const sessionOf = (role: number) => ({
  payload: { iss: '', aud: '', jti: 'j', uid: 7, name: 'kun', role },
  user: { id: 7, name: 'kun', role, status: 0, blocked_tag_ids: DB_BLOCKED }
})

// 只有 'good' 这个 token 对应一个有效会话
const useSession = (role = 1) => {
  verifyKunTokenWithUserMock.mockImplementation(async (token: string) =>
    token === 'good' ? sessionOf(role) : null
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

  const MIRROR_CASES = [
    [undefined, DB_BLOCKED],
    ['', DB_BLOCKED],
    // 空数组是合法镜像: 用户清空了屏蔽列表, 不回落库里的值
    ['[]', []],
    ['[7%2C8]', [7, 8]],
    ['%5B7%2C8%5D', [7, 8]],
    // 归一化: 去重、丢掉非正整数与越过 int4 的值
    ['[8%2C"8"%2C0%2C-1%2C1.5%2C2147483648%2C7]', [8, 7]],
    // 畸形转义回落原值后解析失败、坏 JSON、不是数组: 镜像不可用, 以库为准
    ['%2', DB_BLOCKED],
    ['100%', DB_BLOCKED],
    ['kun', DB_BLOCKED],
    ['{"a":1}', DB_BLOCKED],
    // 未编码的逗号本身就是合法 cookie 字符
    ['[7,8]', [7, 8]]
  ] as const

  const TOKEN_CASES = [
    [undefined, false],
    ['', false],
    ['stale', false],
    ['good', true]
  ] as const

  const matrix = TOKEN_CASES.flatMap(([token, authenticated]) =>
    NSFW_CASES.flatMap(([nsfw, contentLimit]) =>
      MIRROR_CASES.map(([mirror, blockedTagIds]) => ({
        header: cookieHeader({
          [TOKEN]: token,
          [NSFW]: nsfw,
          [MIRROR]: mirror
        }),
        expected: authenticated
          ? { contentLimit, blockedTagIds }
          : { contentLimit: 'sfw', blockedTagIds: [] },
        verifications: token ? 1 : 0
      }))
    )
  )

  // 会话 × 分级设置 × 屏蔽标签镜像的全组合: 无效会话一律是公开视角, 与两个设置 cookie 无关
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
    const ctx = createViewerContext(
      `${TOKEN}=good; ${NSFW}=all; ${NSFW}=nsfw; ${MIRROR}=[1]; ${MIRROR}=[2]`
    )

    await expect(ctx.visibility()).resolves.toEqual({
      contentLimit: 'nsfw',
      blockedTagIds: [2]
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
      const ctx = createViewerContext(
        cookieHeader({ [TOKEN]: 'good', [NSFW]: nsfw, [MIRROR]: '[]' })
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

  it.each([
    ['镜像', '[8%2C7]', [8, 7]],
    ['库', undefined, DB_BLOCKED]
  ] as const)(
    '屏蔽标签来自%s: filtered, 不带视角段',
    async (_, mirror, blockedTagIds) => {
      const ctx = createViewerContext(
        cookieHeader({ [TOKEN]: 'good', [MIRROR]: mirror })
      )
      const expected = {
        kind: 'filtered',
        visibility: { contentLimit: 'sfw', blockedTagIds }
      }

      await expect(ctx.listView()).resolves.toEqual(expected)
      await expect(
        ctx.listView({ personalizedByPendingResource: true })
      ).resolves.toEqual(expected)
    }
  )

  it('有待审核资源的作者: 只有声明了 personalizedByPendingResource 才是 personal', async () => {
    useSession(2)
    hasPendingResourceMock.mockResolvedValue(true)
    const ctx = createViewerContext(
      cookieHeader({ [TOKEN]: 'good', [NSFW]: 'all', [MIRROR]: '[]' })
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
      viewer: sessionOf(2).payload
    })
    expect(hasPendingResourceMock).toHaveBeenCalledWith(7)
  })

  it('管理员: personal, 不必查待审核资源; 屏蔽标签照带', async () => {
    useSession(3)
    const ctx = createViewerContext(
      cookieHeader({ [TOKEN]: 'good', [MIRROR]: '[7%2C8]' })
    )

    await expect(
      ctx.listView({ personalizedByPendingResource: true })
    ).resolves.toEqual({
      kind: 'personal',
      visibility: { contentLimit: 'sfw', blockedTagIds: [7, 8] },
      viewer: sessionOf(3).payload
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
    expect(visibility).toEqual({ contentLimit: 'sfw', blockedTagIds: [7, 8] })
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
