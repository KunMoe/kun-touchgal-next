import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestError } from '~/instrumentation'

let lines: string[]

beforeEach(() => {
  lines = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const renderContext = {
  routerKind: 'App Router',
  routePath: '/user/setting/email/revert',
  routeType: 'render',
  renderSource: 'react-server-components',
  revalidateReason: undefined,
  renderType: 'dynamic'
} as const

describe('onRequestError', () => {
  it('记一条 request.unhandled: 带路由上下文、digest、x-request-id 与堆栈; query 与其余请求头都不进日志', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    const error = Object.assign(new Error('render exploded'), {
      digest: '2381930472'
    })
    await onRequestError(
      error,
      {
        path: '/api/user/setting/email/revert?token=REVERT-SECRET',
        method: 'GET',
        headers: {
          cookie: 'kun-galgame-patch-moe-token=SESSION-SECRET',
          authorization: 'Bearer AUTH-SECRET',
          'x-request-id': 'req-42'
        }
      },
      renderContext
    )

    expect(lines).toHaveLength(1)
    const output = lines[0]
    expect(output).not.toContain('REVERT-SECRET')
    expect(output).not.toContain('SESSION-SECRET')
    expect(output).not.toContain('AUTH-SECRET')
    const record = JSON.parse(output)
    expect(record).toMatchObject({
      level: 'error',
      event: 'request.unhandled',
      fields: {
        path: '/api/user/setting/email/revert',
        method: 'GET',
        routePath: '/user/setting/email/revert',
        routeType: 'render',
        renderSource: 'react-server-components',
        digest: '2381930472',
        requestId: 'req-42'
      },
      err: { name: 'Error', message: 'render exploded', digest: '2381930472' }
    })
    expect(record.err.stack.length).toBeGreaterThan(0)
  })

  it('Route Handler 的错误没有 digest, 照样带堆栈记下', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    await onRequestError(
      new TypeError('x is undefined'),
      {
        path: '/api/patch',
        method: 'POST',
        headers: { 'x-request-id': ['first', 'second'] }
      },
      {
        routerKind: 'App Router',
        routePath: '/api/patch/route',
        routeType: 'route',
        revalidateReason: undefined
      } as never
    )
    const record = JSON.parse(lines[0])
    expect(record.fields).toEqual({
      path: '/api/patch',
      method: 'POST',
      routePath: '/api/patch/route',
      routeType: 'route',
      requestId: 'first'
    })
    expect(record.err.name).toBe('TypeError')
    expect(record.err.stack.length).toBeGreaterThan(0)
  })

  it('不在 Node runtime 时什么也不做', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge')
    await onRequestError(
      new Error('edge'),
      { path: '/', method: 'GET', headers: {} },
      renderContext
    )
    expect(lines).toHaveLength(0)
  })
})
