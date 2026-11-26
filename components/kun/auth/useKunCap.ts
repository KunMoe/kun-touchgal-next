import toast from 'react-hot-toast'
import { flushSync } from 'react-dom'
import { useEffect, useEffectEvent, useReducer, useRef } from 'react'
import type { Cap, CapErrorCode } from 'cap-widget'

// 人机验证的求解引擎。界面由 KunCaptchaModal 自己画, 厂商的 cap-widget 只当看不见的引擎用:
// 走它公开的 programmatic 入口 (Cap 类), 不把它的可见 UI 放进页面

export type KunCapState =
  | { status: 'loading' }
  | { status: 'idle' }
  | { status: 'solving'; progress: number }
  | { status: 'solved' }
  | { status: 'error'; code: CapErrorCode | 'load_failed' }

export type KunCapEvent =
  | { type: 'open' }
  | { type: 'ready' }
  | { type: 'start' }
  | { type: 'progress'; progress: number }
  | { type: 'solved' }
  | { type: 'error'; code: CapErrorCode | 'load_failed' }

export const kunCapReducer = (
  state: KunCapState,
  event: KunCapEvent
): KunCapState => {
  switch (event.type) {
    case 'open':
      return { status: 'loading' }
    case 'ready':
      return state.status === 'loading' ? { status: 'idle' } : state
    case 'start':
      return state.status === 'idle' || state.status === 'error'
        ? { status: 'solving', progress: 0 }
        : state
    case 'progress':
      return state.status === 'solving'
        ? {
            status: 'solving',
            progress: Math.min(100, Math.max(0, event.progress))
          }
        : state
    case 'solved':
      return { status: 'solved' }
    case 'error':
      // 令牌已经交出去了, 之后厂商再报什么 (例如过期时间不合法) 都不改结论
      return state.status === 'solved'
        ? state
        : { status: 'error', code: event.code }
  }
}

type KunCapModule = typeof import('cap-widget')

let capModule: Promise<KunCapModule> | null = null

// 整个页面只加载一次厂商模块; 加载失败不记住, 下次调用重新取
export const preloadKunCap = () => {
  if (!capModule) {
    // 自托管的 wasm 地址要在厂商模块第一次求值之前设好: 它一求值就按这个地址去取 wasm
    // (没设会改取 jsdelivr)。public/cap/ 那份与 widget 要的版本是否一致由
    // __tests__/capVendorContract.test.ts 守着
    window.CAP_CUSTOM_WASM_URL = '/cap/cap_wasm_bg.wasm'
    // 厂商每次发请求时取用: 注入 CSRF 头以通过 proxy.ts 的校验 (与 utils/kunFetch.ts 一致)
    window.CAP_CUSTOM_FETCH = (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('X-Requested-With', 'kun-fetch')
      return fetch(input, { ...init, headers, credentials: 'include' })
    }
    capModule = import('cap-widget')
    capModule.catch(() => {
      capModule = null
    })
  }
  return capModule
}

interface KunCapSessionOptions {
  dispatch: (event: KunCapEvent) => void
  onSolve: (token: string) => void
  load?: () => Promise<KunCapModule>
}

// 弹窗打开一次对应一段会话: 建一个厂商实例、把它的事件翻成状态机的事件, 返回开始解题与销毁两个动作。
// 销毁之后, 以及令牌交出之后, 这个实例再派发什么都不往外报 —— 调用方把「关闭弹窗」当成取消
// (上传那里还会丢掉已选的文件), 关闭后还在途的那一题不得再走到 onSolve
export const startKunCapSession = ({
  dispatch,
  onSolve,
  load = preloadKunCap
}: KunCapSessionOptions) => {
  let live = true
  let cap: Cap | null = null
  dispatch({ type: 'open' })

  load().then(
    // 只能取 default: 厂商的产物是 CommonJS 的 module.exports = Cap, 类型声明里的
    // 具名导出 Cap 在运行时是 undefined
    ({ default: KunCap }) => {
      if (!live) {
        return
      }
      try {
        // 不传宿主元素时厂商自己建一个 <cap-widget>, 设成内联的 display: none 挂到 <html> 下
        cap = new KunCap({ apiEndpoint: '/api/auth/captcha/' })
        // 「宿主不可见」是本站不露出厂商界面的前提: 补上 !important, 样式表里的规则盖不过它
        cap.widget.style.setProperty('display', 'none', 'important')

        cap.addEventListener('progress', (event) => {
          if (live) {
            dispatch({ type: 'progress', progress: event.detail.progress })
          }
        })
        cap.addEventListener('solve', (event) => {
          if (!live) {
            return
          }
          live = false
          // 登录之外的调用方拿到令牌就同步关弹窗, 而退场动画播的是关闭前最后提交的那一帧:
          // 先把「验证通过」提交上去, 否则用户看到的是停在「正在验证」的框淡出
          flushSync(() => dispatch({ type: 'solved' }))
          onSolve(event.detail.token)
        })
        cap.addEventListener('error', (event) => {
          if (!live) {
            return
          }
          dispatch({ type: 'error', code: event.detail.code })
          toast.error('人机验证出错, 请重试')
        })

        dispatch({ type: 'ready' })
      } catch (error) {
        // 模块取到了却建不出实例 (例如厂商升级后导出的形状变了)。这与网络问题不同, 重试没有用,
        // 所以留下线索, 并把建到一半的宿主拿掉
        // eslint-disable-next-line no-console -- 客户端没有日志出口 (上报暂缓, T38 S5), 只留在浏览器控制台
        console.error('[captcha] 无法创建 cap-widget 实例', error)
        cap?.widget.remove()
        cap = null
        dispatch({ type: 'error', code: 'load_failed' })
      }
    },
    () => {
      if (live) {
        dispatch({ type: 'error', code: 'load_failed' })
      }
    }
  )

  return {
    solve: () => {
      if (!cap) {
        return
      }
      dispatch({ type: 'start' })
      // 结果只经事件送达; solve() 自己返回的 promise 在失败时也会 reject, 这里不重复处理
      void cap.solve().catch(() => {})
    },
    dispose: () => {
      live = false
      // 不逐个解绑监听, 移除宿主就够了: 厂商在 disconnectedCallback 里中止在途请求、结束 worker,
      // 没解完的那一题不再派发 solve / error
      cap?.widget.remove()
      cap = null
    }
  }
}

// 必须在常驻挂载的组件里调用 (不要放进 ModalBody 的子组件): 子组件要等退场动画结束才卸载,
// 会话也就晚那么久才销毁, 那段时间里解出的令牌还会交给 onSolve
export const useKunCap = (
  isOpen: boolean,
  onSolve: (token: string) => void
) => {
  const [state, dispatch] = useReducer(kunCapReducer, { status: 'loading' })
  const [loadAttempt, retryLoad] = useReducer((count: number) => count + 1, 0)
  const sessionRef = useRef<ReturnType<typeof startKunCapSession> | null>(null)
  const handleSolve = useEffectEvent(onSolve)

  useEffect(() => {
    if (!isOpen) {
      return
    }
    const session = startKunCapSession({
      dispatch,
      onSolve: (token) => handleSolve(token)
    })
    sessionRef.current = session
    return () => {
      session.dispose()
      sessionRef.current = null
    }
  }, [isOpen, loadAttempt])

  const canSolve = state.status === 'idle' || state.status === 'error'

  const solve = () => {
    if (!canSolve) {
      return
    }
    if (state.status === 'error' && state.code === 'load_failed') {
      // 厂商模块没取到: 不用关弹窗 (上传那里关闭等于取消), 原地重开一段会话, 把加载重走一遍
      retryLoad()
      return
    }
    sessionRef.current?.solve()
  }

  return { state, canSolve, solve }
}
