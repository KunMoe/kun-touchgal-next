import { useMemo } from 'react'
import {
  kunIsPageSelected,
  kunVisibleSelection,
  type KunListQuery
} from '~/utils/list/kunListMachine'
import { useKunListCore, type KunListHookOptions } from './useKunListCore'

// 分页列表 (admin 容器、消息、收藏夹)。生命周期规则见 utils/list/kunListMachine.ts:
// 新容器用它, 不要再照抄某个容器里的 requestId 守卫、钳制与静默补齐
export const useKunPagedList = <T, Q extends KunListQuery<Q>>(
  options: KunListHookOptions<T, Q>
) => {
  const { state, dispatch, config, list } = useKunListCore(options)

  // 批量操作与「已选择 N 条」只读这一份: 当前查询下可见且可选的选中行
  const ids = useMemo(() => kunVisibleSelection(config, state), [config, state])
  const selection = useMemo(
    () => ({
      ids,
      isPageSelected: kunIsPageSelected(config, state),
      toggle: (id: number, selected: boolean) =>
        dispatch({ type: 'select', op: 'toggle', id, selected }),
      togglePage: () => dispatch({ type: 'select', op: 'togglePage' }),
      replace: (next: readonly number[]) =>
        dispatch({ type: 'select', op: 'replace', ids: next }),
      clear: () => dispatch({ type: 'select', op: 'clear' })
    }),
    [config, state, ids, dispatch]
  )

  return { ...list, selection }
}
