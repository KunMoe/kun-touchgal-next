import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KUN_LOG_EVENTS, kunLog } from '~/lib/log.server'

type Written = { stream: 'stdout' | 'stderr'; record: Record<string, unknown> }

let written: Written[]

const capture = (stream: 'stdout' | 'stderr') =>
  vi.spyOn(process[stream], 'write').mockImplementation((chunk: unknown) => {
    const text = String(chunk)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.indexOf('\n')).toBe(text.length - 1)
    written.push({ stream, record: JSON.parse(text) })
    return true
  })

beforeEach(() => {
  written = []
  capture('stdout')
  capture('stderr')
  // 节流状态是模块级的: 每个用例跳到新的时刻, 上一个用例的窗口都已过期
  vi.useFakeTimers()
  vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 * (1 + Math.random()))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('kunLog', () => {
  it('每条一行 JSON, 信封齐全, 字段嵌套在 fields 里', () => {
    vi.stubEnv('NODE_APP_INSTANCE', '3')
    vi.stubEnv('KUN_RELEASE_SHA', 'abc123')
    kunLog('route.violation', {
      method: 'POST',
      path: '/api/x',
      uid: 7,
      code: 'P2002'
    })
    expect(written).toHaveLength(1)
    const [{ stream, record }] = written
    expect(stream).toBe('stderr')
    expect(record).toEqual({
      ts: new Date().toISOString(),
      level: 'warn',
      event: 'route.violation',
      app: 'cli',
      pid: process.pid,
      instance: '3',
      release: 'abc123',
      fields: { method: 'POST', path: '/api/x', uid: 7, code: 'P2002' }
    })
  })

  it('级别取自登记表: info 写 stdout, warn / error 写 stderr', () => {
    kunLog('job.shutdown_signal', { signal: 'SIGINT' })
    kunLog('search.enqueue_failed', { patchId: 1 })
    expect(written.map(({ stream, record }) => [stream, record.level])).toEqual(
      [
        ['stdout', 'info'],
        ['stderr', 'error']
      ]
    )
  })

  it('app 按运行环境: Next 之外是 cli, cron 进程是 cron, 其余是 web', () => {
    kunLog('job.shutdown_signal', {})
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    kunLog('job.shutdown_signal', {})
    vi.stubEnv('KUN_ENABLE_CRON', 'true')
    kunLog('job.shutdown_signal', {})
    expect(written.map(({ record }) => record.app)).toEqual([
      'cli',
      'web',
      'cron'
    ])
  })

  it('没登记的字段在运行时丢弃, undefined 不写出, 字符串截到 256', () => {
    const fields = {
      method: 'GET',
      path: 'x'.repeat(300),
      uid: undefined,
      headers: { cookie: 'kun-galgame-patch-moe-token=secret' },
      email: 'a@b.c'
    }
    kunLog('route.violation', fields)
    const record = written[0].record
    expect(record.fields).toEqual({
      method: 'GET',
      path: `${'x'.repeat(256)}…`
    })
    expect(JSON.stringify(record)).not.toContain('secret')
    expect(JSON.stringify(record)).not.toContain('a@b.c')
  })

  it('类型拦不住的对象值只留字符串形式', () => {
    kunLog('route.violation', { path: { nested: 1 } as never })
    expect(written[0].record.fields).toEqual({ path: '[object Object]' })
  })

  it('err 只留 name / message / code / digest / 前 15 帧调用栈与一层 cause, 丢弃 meta', () => {
    const cause = Object.assign(new Error('pool exhausted'), {
      code: 'ECONNREFUSED',
      cause: new Error('deeper')
    })
    const error = Object.assign(new Error('boom'), {
      code: 'P2002',
      digest: '12345',
      meta: { target: ['email'], modelName: 'user' },
      cause
    })
    error.stack = [
      'Error: boom',
      '  with a second message line',
      ...Array.from({ length: 20 }, (_, i) => `    at frame${i} (file.ts:${i})`)
    ].join('\n')
    kunLog('search.drain_failed', {}, error)
    const err = written[0].record.err as Record<string, unknown>
    expect(err).toEqual({
      name: 'Error',
      message: 'boom',
      code: 'P2002',
      digest: '12345',
      stack: Array.from(
        { length: 15 },
        (_, i) => `at frame${i} (file.ts:${i})`
      ),
      cause: { name: 'Error', message: 'pool exhausted', code: 'ECONNREFUSED' }
    })
    expect(JSON.stringify(written[0].record)).not.toContain('modelName')
  })

  it('message 截到 2000; 调用栈不带首行, 截断不会被栈绕过', () => {
    const long = `${'参数'.repeat(1500)}`
    const error = new Error(long)
    kunLog('search.drain_failed', {}, error)
    const err = written[0].record.err as { message: string; stack: string[] }
    expect(err.message).toHaveLength(2001)
    expect(err.stack.every((frame) => frame.startsWith('at '))).toBe(true)
    expect(JSON.stringify(err.stack)).not.toContain('参数')
  })

  it('不是 Error 的值按字符串记 message', () => {
    kunLog('search.drain_failed', {}, 'plain reason')
    kunLog('search.drain_failed', {}, { reason: 'x' })
    expect(written.map(({ record }) => record.err)).toEqual([
      { message: 'plain reason' },
      { message: '[object Object]' }
    ])
  })

  it('节流: 同一窗口只放行第一条, 下一条放行时带上压下的条数; 按 throttleBy 的值分开计', () => {
    kunLog('cache.degraded', { ns: 'a', op: 'read' })
    kunLog('cache.degraded', { ns: 'a', op: 'write' })
    kunLog('cache.degraded', { ns: 'a', op: 'read' })
    kunLog('cache.degraded', { ns: 'b', op: 'read' })
    expect(written.map(({ record }) => record.fields)).toEqual([
      { ns: 'a', op: 'read' },
      { ns: 'b', op: 'read' }
    ])
    vi.advanceTimersByTime(60_000)
    kunLog('cache.degraded', { ns: 'a', op: 'read' })
    kunLog('cache.degraded', { ns: 'b', op: 'read' })
    expect(written.slice(2).map(({ record }) => record.suppressed)).toEqual([
      2,
      undefined
    ])
  })

  it('没有 throttleBy 的节流事件整体共用一个窗口', () => {
    kunLog('abuse.budget_unavailable', { policies: 'comment.create' })
    kunLog('abuse.budget_unavailable', { policies: 'report.create' })
    expect(written).toHaveLength(1)
  })

  it('不节流的事件每条都写', () => {
    kunLog('search.enqueue_failed', { patchId: 1 })
    kunLog('search.enqueue_failed', { patchId: 1 })
    expect(written).toHaveLength(2)
  })

  it('永不抛出: 读错误对象时抛错, 退化为只有事件与级别的一行', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('getter exploded')
        }
      }
    )
    expect(() => kunLog('search.drain_failed', {}, hostile)).not.toThrow()
    expect(written[0].record).toEqual({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'search.drain_failed',
      serializeFailed: true
    })
  })

  it('永不抛出: 写入本身抛错也吞掉', () => {
    vi.mocked(process.stderr.write).mockImplementation(() => {
      throw new Error('EPIPE')
    })
    expect(() => kunLog('search.drain_failed', {})).not.toThrow()
  })
})

describe('KUN_LOG_EVENTS', () => {
  it('throttleBy 只指向本事件登记的字段, 节流窗口为正', () => {
    for (const [event, spec] of Object.entries(KUN_LOG_EVENTS)) {
      const { fields, throttleBy, throttleMs } = spec as {
        fields: readonly string[]
        throttleBy?: string
        throttleMs?: number
      }
      if (throttleBy !== undefined) {
        expect(fields, event).toContain(throttleBy)
        expect(throttleMs, event).toBeGreaterThan(0)
      }
      expect(new Set(fields).size, event).toBe(fields.length)
    }
  })

  it('事件名是「领域.事件」的小写形式', () => {
    for (const event of Object.keys(KUN_LOG_EVENTS)) {
      expect(event).toMatch(/^[a-z0-9]+\.[a-z0-9_]+$/)
    }
  })
})
