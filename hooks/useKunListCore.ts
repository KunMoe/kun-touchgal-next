import {
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import {
  kunInitList,
  kunReduceList,
  type KunListConfig,
  type KunListPage,
  type KunListQuery
} from '~/utils/list/kunListMachine'

// useKunPagedList / useKunInfiniteList / useKunKeyedQuery 共用的接线。这里只发请求、把应答交给
// utils/list/kunListMachine.ts 的纯函数; 哪个应答能落地、失败后停在哪, 都不在这里判断

type KunResponseEvent<D> =
  | { type: 'success'; seq: number; data: D }
  | { type: 'failure'; seq: number; message: string }

// 每个序号只发一次。不能只靠 request 的引用判断: 不同优先级的更新交错时 React 会从基础状态
// 重放更新队列, 同一序号会再算出一个内容相同、引用不同的 request (实测改每页条数时发了两遍);
// StrictMode 在开发环境挂载时也会把 effect 跑两遍
export const useKunRequestRunner = <R extends { seq: number }, D>(
  request: R | null,
  enabled: boolean,
  send: (request: R) => Promise<D | string>,
  dispatch: (event: KunResponseEvent<D>) => void
) => {
  const sendEvent = useEffectEvent(send)
  const sentSeqRef = useRef(0)

  useEffect(() => {
    if (!request || !enabled || sentSeqRef.current === request.seq) {
      return
    }
    const { seq } = request
    sentSeqRef.current = seq
    // kunFetch 不为请求失败抛异常; 这里的 reject 只可能是取数函数自己的编程错误
    sendEvent(request).then(
      (res) =>
        dispatch(
          typeof res === 'string'
            ? { type: 'failure', seq, message: res }
            : { type: 'success', seq, data: res }
        ),
      (error: unknown) =>
        dispatch({
          type: 'failure',
          seq,
          message: error instanceof Error ? error.message : '发生未知错误'
        })
    )
  }, [request, enabled])
}

// 每次落地的前台失败只通知一次: 按失败请求的序号判断, 理由同上 (重放会换掉 error 的引用)
export const useKunFailureNotice = (
  error: { seq: number; message: string } | null,
  onFailure?: (message: string) => void
) => {
  const notify = useEffectEvent((message: string) => onFailure?.(message))
  const notifiedSeqRef = useRef(0)

  useEffect(() => {
    if (error && notifiedSeqRef.current !== error.seq) {
      notifiedSeqRef.current = error.seq
      notify(error.message)
    }
  }, [error])
}

export interface KunListHookOptions<
  T,
  Q extends KunListQuery<Q>
> extends KunListConfig<T> {
  // 初始查询; 之后只经 setQuery / setPage 改
  query: Q
  // SSR 首屏数据: 给了就不在挂载时请求
  initial?: KunListPage<T>
  fetchPage: (query: Q) => Promise<KunListPage<T> | string>
  enabled?: boolean
  onFailure?: (message: string) => void
}

export const useKunListCore = <T, Q extends KunListQuery<Q>>(
  options: KunListHookOptions<T, Q>
) => {
  // 配置 (getId / isSelectable / 策略) 只取首次渲染的: 它们是纯函数, 不随渲染变化
  const [config] = useState<KunListConfig<T>>(() => options)
  const [reduce] = useState(() => kunReduceList<T, Q>(config))
  const [state, dispatch] = useReducer(reduce, options, (initialOptions) =>
    kunInitList(config, initialOptions.query, initialOptions.initial)
  )
  const enabled = options.enabled ?? true

  useKunRequestRunner(
    state.request,
    enabled,
    (request) => options.fetchPage(request.query),
    dispatch
  )
  useKunFailureNotice(state.error, options.onFailure)

  const actions = useMemo(
    () => ({
      setQuery: (patch: Partial<Omit<Q, 'page'>>) =>
        dispatch({ type: 'setQuery', patch }),
      setPage: (page: number) => dispatch({ type: 'setPage', page }),
      refresh: ({ background = false }: { background?: boolean } = {}) =>
        dispatch({ type: 'refresh', background }),
      removeLocal: (ids: readonly number[]) =>
        dispatch({ type: 'removeLocal', ids }),
      patchLocal: (id: number, patch: Partial<T>) =>
        dispatch({ type: 'patchLocal', id, patch }),
      insertLocal: (item: T, at: 'start' | 'end') =>
        dispatch({ type: 'insertLocal', item, at })
    }),
    []
  )

  return {
    state,
    dispatch,
    config,
    enabled,
    // 宿主读写的部分; state / dispatch 只给本目录的 hook 用
    list: {
      items: state.items,
      total: state.total,
      query: state.query,
      status: enabled ? state.status : ('idle' as const),
      error: state.error?.message ?? null,
      // 新查询还没落地时手里的行属于旧查询
      isStale: state.itemsEpoch !== state.epoch,
      ...actions
    }
  }
}
