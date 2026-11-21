import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import toast from 'react-hot-toast'
import { flushSync } from 'react-dom'
import {
  kunCapReducer,
  startKunCapSession
} from '~/components/kun/auth/useKunCap'
import type { KunCapEvent, KunCapState } from '~/components/kun/auth/useKunCap'

vi.mock('react-hot-toast', () => ({ default: { error: vi.fn() } }))
vi.mock('react-dom', () => ({ flushSync: vi.fn((fn: () => void) => fn()) }))

const LOADING: KunCapState = { status: 'loading' }
const IDLE: KunCapState = { status: 'idle' }
const SOLVING: KunCapState = { status: 'solving', progress: 40 }
const SOLVED: KunCapState = { status: 'solved' }
const FAILED: KunCapState = { status: 'error', code: 'solve_failed' }
const LOAD_FAILED: KunCapState = { status: 'error', code: 'load_failed' }
const ALL = [LOADING, IDLE, SOLVING, SOLVED, FAILED, LOAD_FAILED]

const run = (events: KunCapEvent[], from: KunCapState = LOADING) =>
  events.reduce(kunCapReducer, from)

describe('kunCapReducer', () => {
  it('open 从任何状态都回到 loading (上一次打开留下的结果不带进这一次)', () => {
    for (const state of ALL) {
      expect(kunCapReducer(state, { type: 'open' })).toEqual(LOADING)
    }
  })

  it('ready 只在 loading 时生效', () => {
    expect(kunCapReducer(LOADING, { type: 'ready' })).toEqual(IDLE)
    for (const state of ALL.filter((state) => state !== LOADING)) {
      expect(kunCapReducer(state, { type: 'ready' })).toBe(state)
    }
  })

  it('start 只在 idle 或出错之后生效, 进度从 0 起', () => {
    const started = { status: 'solving', progress: 0 }
    expect(kunCapReducer(IDLE, { type: 'start' })).toEqual(started)
    expect(kunCapReducer(FAILED, { type: 'start' })).toEqual(started)
  })

  it('加载中、解题中、已通过时的 start 不改状态 (重复点击不会把进度打回 0)', () => {
    for (const state of [LOADING, SOLVING, SOLVED]) {
      expect(kunCapReducer(state, { type: 'start' })).toBe(state)
    }
  })

  it('progress 只在解题中生效, 并钳到 0–100', () => {
    const at = (progress: number) =>
      kunCapReducer(SOLVING, { type: 'progress', progress })
    expect(at(73)).toEqual({ status: 'solving', progress: 73 })
    expect(at(-5)).toEqual({ status: 'solving', progress: 0 })
    expect(at(250)).toEqual({ status: 'solving', progress: 100 })
    for (const state of ALL.filter((state) => state !== SOLVING)) {
      expect(kunCapReducer(state, { type: 'progress', progress: 73 })).toBe(
        state
      )
    }
  })

  it('error 记下错误码; 加载失败用 load_failed', () => {
    expect(
      kunCapReducer(SOLVING, { type: 'error', code: 'invalid_solution' })
    ).toEqual({ status: 'error', code: 'invalid_solution' })
    expect(
      kunCapReducer(LOADING, { type: 'error', code: 'load_failed' })
    ).toEqual(LOAD_FAILED)
  })

  it('solved 从任何状态都生效 (令牌已经到手), 并且是终态: 之后到达的 error 被忽略', () => {
    for (const state of ALL) {
      expect(kunCapReducer(state, { type: 'solved' })).toEqual(SOLVED)
    }
    expect(
      kunCapReducer(SOLVED, { type: 'error', code: 'invalid_expires' })
    ).toBe(SOLVED)
  })

  it('一次完整的解题', () => {
    expect(
      run([
        { type: 'open' },
        { type: 'ready' },
        { type: 'start' },
        { type: 'progress', progress: 0 },
        { type: 'progress', progress: 62 },
        { type: 'progress', progress: 100 },
        { type: 'solved' }
      ])
    ).toEqual(SOLVED)
  })

  it('出错后重试, 再次打开时从头开始', () => {
    const retried = run([
      { type: 'open' },
      { type: 'ready' },
      { type: 'start' },
      { type: 'progress', progress: 30 },
      { type: 'error', code: 'network_error' },
      { type: 'start' }
    ])
    expect(retried).toEqual({ status: 'solving', progress: 0 })
    expect(run([{ type: 'solved' }, { type: 'open' }], retried)).toEqual(
      LOADING
    )
  })
})

describe('preloadKunCap', () => {
  // 厂商模块求值时读到的 window 上的配置; 用 vi.doMock 的工厂充当「模块求值」
  const loadWith = async (factory: () => Record<string, unknown>) => {
    vi.resetModules()
    vi.doMock('cap-widget', factory)
    const { preloadKunCap } = await import('~/components/kun/auth/useKunCap')
    return preloadKunCap
  }

  beforeEach(() => {
    vi.stubGlobal('window', {})
  })

  afterEach(() => {
    vi.doUnmock('cap-widget')
    vi.unstubAllGlobals()
  })

  it('先设好 wasm 地址与带 CSRF 头的 fetch, 再让厂商模块求值', async () => {
    const seen: Record<string, unknown> = {}
    const preloadKunCap = await loadWith(() => {
      seen.wasm = window.CAP_CUSTOM_WASM_URL
      seen.fetch = typeof window.CAP_CUSTOM_FETCH
      return { default: class {} }
    })

    await preloadKunCap()

    expect(seen).toEqual({ wasm: '/cap/cap_wasm_bg.wasm', fetch: 'function' })
  })

  it('厂商发出的请求带上 X-Requested-With 与 cookie, 原有的头不丢', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const preloadKunCap = await loadWith(() => ({ default: class {} }))
    await preloadKunCap()

    await window.CAP_CUSTOM_FETCH!('/api/auth/captcha/redeem', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' }
    })

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit
    ]
    const headers = new Headers(init.headers)
    expect(input).toBe('/api/auth/captcha/redeem')
    expect(init).toMatchObject({
      method: 'POST',
      body: '{}',
      credentials: 'include'
    })
    expect(headers.get('X-Requested-With')).toBe('kun-fetch')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('整个页面只加载一次', async () => {
    const factory = vi.fn(() => ({ default: class {} }))
    const preloadKunCap = await loadWith(factory)

    const first = preloadKunCap()
    expect(preloadKunCap()).toBe(first)
    await first
    expect(preloadKunCap()).toBe(first)
  })

  it('加载失败不记住: 下一次调用重新加载', async () => {
    let broken = true
    const preloadKunCap = await loadWith(() => {
      if (broken) {
        throw new Error('chunk load failed')
      }
      return { default: class {} }
    })

    const failed = preloadKunCap()
    await expect(failed).rejects.toThrow()

    broken = false
    const retried = preloadKunCap()
    expect(retried).not.toBe(failed)
    await expect(retried).resolves.toBeDefined()
  })
})

describe('startKunCapSession', () => {
  // 厂商 Cap 类的替身: 事件走 Node 自带的 EventTarget, 不需要 DOM
  const makeFakeCap = () => {
    const instances: FakeCap[] = []
    class FakeCap {
      widget = Object.assign(new EventTarget(), {
        style: { setProperty: vi.fn() },
        remove: vi.fn()
      })
      solve = vi.fn(async () => undefined)
      constructor(public config: unknown) {
        instances.push(this)
      }
      addEventListener(type: string, listener: EventListener) {
        this.widget.addEventListener(type, listener)
      }
    }
    return { FakeCap, instances }
  }

  const emit = (cap: { widget: EventTarget }, type: string, detail: unknown) =>
    cap.widget.dispatchEvent(new CustomEvent(type, { detail }))
  const settle = () => new Promise((resolve) => setTimeout(resolve))

  const start = (load: () => Promise<unknown>) => {
    const dispatch = vi.fn<(event: KunCapEvent) => void>()
    const onSolve = vi.fn<(token: string) => void>()
    const session = startKunCapSession({
      dispatch,
      onSolve,
      load: load as never
    })
    const events = () => dispatch.mock.calls.map(([event]) => event)
    return { session, dispatch, onSolve, events }
  }

  const startReady = async () => {
    const { FakeCap, instances } = makeFakeCap()
    const started = start(async () => ({ default: FakeCap }))
    await settle()
    return { ...started, cap: instances[0], instances }
  }

  beforeEach(() => {
    vi.mocked(toast.error).mockClear()
    vi.mocked(flushSync).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('模块到手后用默认导出建一个实例, 把宿主钉成不可见, 进入 idle', async () => {
    const { cap, instances, events } = await startReady()

    expect(instances).toHaveLength(1)
    expect(cap.config).toEqual({ apiEndpoint: '/api/auth/captcha/' })
    expect(cap.widget.style.setProperty).toHaveBeenCalledWith(
      'display',
      'none',
      'important'
    )
    expect(events()).toEqual([{ type: 'open' }, { type: 'ready' }])
  })

  it('实例就绪之前 solve 什么也不做, 就绪之后开始解题', async () => {
    const { FakeCap, instances } = makeFakeCap()
    const { session, events } = start(async () => ({ default: FakeCap }))

    session.solve()
    expect(events()).toEqual([{ type: 'open' }])

    await settle()
    session.solve()

    expect(instances[0].solve).toHaveBeenCalledTimes(1)
    expect(events()).toEqual([
      { type: 'open' },
      { type: 'ready' },
      { type: 'start' }
    ])
  })

  it('厂商的 solve() 失败时 reject 的 promise 有人接 (结果只看 error 事件)', async () => {
    const { session, cap } = await startReady()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    // 不用 vi.fn: 它会给返回的 promise 挂上处理函数, 测不出「没人接」
    cap.solve = (() => Promise.reject(new Error('solve_failed'))) as never

    session.solve()
    await settle()
    process.off('unhandledRejection', unhandled)

    expect(unhandled).not.toHaveBeenCalled()
  })

  it('进度与出错翻成状态机的事件, 出错时提示一次', async () => {
    const { cap, events } = await startReady()

    emit(cap, 'progress', { progress: 42 })
    emit(cap, 'error', { code: 'network_error' })

    expect(events().slice(2)).toEqual([
      { type: 'progress', progress: 42 },
      { type: 'error', code: 'network_error' }
    ])
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('人机验证出错, 请重试')
  })

  it('解出: 先同步提交「验证通过」, 再把令牌交给调用方', async () => {
    const { cap, dispatch, onSolve, events } = await startReady()

    emit(cap, 'solve', { token: 'tok-1' })

    expect(flushSync).toHaveBeenCalledTimes(1)
    expect(events().at(-1)).toEqual({ type: 'solved' })
    expect(onSolve).toHaveBeenCalledExactlyOnceWith('tok-1')
    expect(dispatch.mock.invocationCallOrder.at(-1)).toBeLessThan(
      onSolve.mock.invocationCallOrder[0]
    )
  })

  it('令牌只交一次: 之后这个实例再解出或再报错都不往外报', async () => {
    const { cap, onSolve, events } = await startReady()
    emit(cap, 'solve', { token: 'tok-1' })
    const before = events().length

    emit(cap, 'solve', { token: 'tok-2' })
    emit(cap, 'error', { code: 'invalid_expires' })
    emit(cap, 'progress', { progress: 10 })

    expect(onSolve).toHaveBeenCalledTimes(1)
    expect(events()).toHaveLength(before)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('销毁: 移除宿主, 之后还在途的那一题无论解出还是出错都不往外报', async () => {
    const { session, cap, onSolve, events } = await startReady()
    session.solve()
    const before = events().length

    session.dispose()
    emit(cap, 'progress', { progress: 80 })
    emit(cap, 'solve', { token: 'late' })
    emit(cap, 'error', { code: 'network_error' })

    expect(cap.widget.remove).toHaveBeenCalledTimes(1)
    expect(onSolve).not.toHaveBeenCalled()
    expect(events()).toHaveLength(before)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('销毁之后 solve 不再碰厂商实例', async () => {
    const { session, cap, events } = await startReady()

    session.dispose()
    session.solve()

    expect(cap.solve).not.toHaveBeenCalled()
    expect(events()).toEqual([{ type: 'open' }, { type: 'ready' }])
  })

  it('模块在销毁之后才到手: 不建实例', async () => {
    const { FakeCap, instances } = makeFakeCap()
    let deliver = (_module: unknown) => {}
    const { session, events } = start(
      () => new Promise((resolve) => (deliver = resolve))
    )

    session.dispose()
    deliver({ default: FakeCap })
    await settle()

    expect(instances).toHaveLength(0)
    expect(events()).toEqual([{ type: 'open' }])
  })

  it('模块取不到: 报 load_failed; 已经销毁则不报', async () => {
    const failed = start(() => Promise.reject(new Error('chunk load failed')))
    await settle()
    expect(failed.events()).toEqual([
      { type: 'open' },
      { type: 'error', code: 'load_failed' }
    ])

    const disposed = start(() => Promise.reject(new Error('chunk load failed')))
    disposed.session.dispose()
    await settle()
    expect(disposed.events()).toEqual([{ type: 'open' }])
  })

  it('模块到手却建不出实例: 留下日志, 拿掉建到一半的宿主, 报 load_failed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { FakeCap, instances } = makeFakeCap()
    class BrokenCap extends FakeCap {
      addEventListener(): never {
        throw new Error('vendor API changed')
      }
    }

    const { events } = start(async () => ({ default: BrokenCap }))
    await settle()

    expect(instances[0].widget.remove).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledTimes(1)
    expect(events()).toEqual([
      { type: 'open' },
      { type: 'error', code: 'load_failed' }
    ])
  })

  it('只认默认导出: 模块只有具名的 Cap 时当作建不出实例', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { FakeCap, instances } = makeFakeCap()

    const { events } = start(async () => ({ Cap: FakeCap }))
    await settle()

    expect(instances).toHaveLength(0)
    expect(logged).toHaveBeenCalledTimes(1)
    expect(events().at(-1)).toEqual({ type: 'error', code: 'load_failed' })
  })
})
