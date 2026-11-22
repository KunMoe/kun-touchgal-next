import { useEffect, useReducer } from 'react'
import { kunInitKeyed, kunReduceKeyed } from '~/utils/list/kunListMachine'
import { useKunFailureNotice, useKunRequestRunner } from './useKunListCore'

// 一个键对应一份数据 (统计、用户名联想、搜索建议): 只让当前键的应答落地。data 与 dataKey 一起
// 落地, 宿主据此显示「这份数据属于哪个键」; 换键后旧数据仍在, 要不要藏起来由宿主决定
export const useKunKeyedQuery = <K extends string | number, D>({
  key,
  enabled = true,
  fetch,
  onFailure
}: {
  key: K
  enabled?: boolean
  fetch: (key: K) => Promise<D | string>
  onFailure?: (message: string) => void
}) => {
  const [state, dispatch] = useReducer(
    kunReduceKeyed<K, D>,
    key,
    (initialKey) => kunInitKeyed<K, D>(initialKey)
  )

  useEffect(() => {
    dispatch({ type: 'setKey', key })
  }, [key])

  // 换键的那一帧里状态机还停在旧键上 (setKey 在 effect 里才发出): 只发属于当前键的请求,
  // 否则从禁用变为启用的那一帧会把旧键 (例如空查询) 的请求先发出去
  useKunRequestRunner(
    state.request,
    enabled && state.request !== null && Object.is(state.request.key, key),
    (request) => fetch(request.key),
    dispatch
  )
  useKunFailureNotice(state.error, onFailure)

  return {
    data: state.data,
    dataKey: state.dataKey,
    status: enabled ? state.status : ('idle' as const),
    error: state.error?.message ?? null
  }
}
