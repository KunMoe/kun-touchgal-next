import { kunShouldBackfillDeletedRow } from '~/utils/pagination'

// 列表取数的生命周期规则只写在这里 (T17): 只让最新请求落地; 写后刷新取当前查询而不是点击时的闭包;
// 越界页钳制且不卡骨架; 失败进入终态、页码不推进、无限列表停止自动加载; 追加按 id 去重、本地优先;
// 删行后退页或补齐; 查询变了而请求失败时旧数据不留在新查询下。纯模块, 不 import React,
// hooks/useKunPagedList.ts、useKunInfiniteList.ts、useKunKeyedQuery.ts 只负责发请求和观察哨兵。
// 每条规则在 __tests__/kunListMachine.test.ts 里有对应的用例 (多数转写自既往裁定)

export type KunListStatus = 'idle' | 'loading' | 'ready' | 'error'
export type KunListMode = 'replace' | 'append' | 'prepend'

export interface KunListPage<T> {
  items: T[]
  total: number
}

export type KunListQueryValue = string | number | boolean | null

// limit 是查询参数 (admin 列表可改每页条数, 改了回到第 1 页), 钳制、补齐与 hasMore 都按发出请求时的值算。
// 查询的值只能是原始值: setQuery 按 Object.is 逐键比较, 宿主在挂载时把属性或防抖值同步一遍才是空操作;
// 数组或对象每次渲染都是新引用, 会让挂载时把首屏重取一遍
export type KunListQuery<Q = unknown> = { page: number; limit: number } & {
  [K in keyof Q]: KunListQueryValue
}

export interface KunListConfig<T> {
  getId: (item: T) => number
  // toLastPage: 应答的 total 表明本页已越界时转到末页 (total 为 0 时是第 1 页) 再取一次
  clamp?: 'none' | 'toLastPage'
  // 本地删行之后. none: 只删本地。refillIfNext: 本页删空且不在第 1 页时退一页, 否则存在下一页时
  // 静默补齐本页 (offset 分页下后面的行会前移进本页, 不补就会漏看)。alwaysRefill: 同样退页, 否则
  // 总是静默补齐 (服务端连带删除或处理了不在本页的行, 本地递减的 total 只是即时反馈)
  afterRemove?: 'none' | 'refillIfNext' | 'alwaysRefill'
  // 无限列表下一页的行接在哪一端
  grow?: 'append' | 'prepend'
  // 不可选的行 (例如已处理的举报) 不进选中集, 也不算进「全选当前页」
  isSelectable?: (item: T) => boolean
}

interface KunListRequest<Q> {
  seq: number
  // 发出时的查询, page 是这次要取的页 (无限列表取下一页时与 state.query.page 不同)
  query: Q
  mode: KunListMode
  // 后台请求不切 loading、不清错误, 失败时什么都不做
  background: boolean
}

export interface KunListState<T, Q extends KunListQuery<Q>> {
  query: Q
  // 查询每变一次加 1 (翻页、改筛选、钳制)。不变量: request 非空时一定属于当前 epoch,
  // 因为每次改查询都会换掉 request, 所以「序号匹配」已经蕴含「查询没变」
  epoch: number
  // items 属于哪一次查询; 与 epoch 不等即为陈旧数据 (新查询的请求还没落地)
  itemsEpoch: number
  seq: number
  // 唯一会被接受的应答; 落地后清空
  request: KunListRequest<Q> | null
  status: KunListStatus
  items: T[]
  total: number
  loadedPage: number
  hasMore: boolean
  // seq 让宿主的失败回调对每次失败只触发一次
  error: { seq: number; message: string } | null
  // 原始选中集, 可能含已不可见的 id; 读取一律经 kunVisibleSelection
  selected: ReadonlySet<number>
}

export type KunListEvent<T, Q extends KunListQuery<Q>> =
  // 改筛选总是回到第 1 页, 类型上不允许顺手改 page; 值都没变时什么都不做
  | { type: 'setQuery'; patch: Partial<Omit<Q, 'page'>> }
  | { type: 'setPage'; page: number }
  // 意图事件: 参数取发出时的 state.query, 宿主拿不到闭包里的旧参数
  | { type: 'refresh'; background?: boolean }
  | { type: 'loadMore' }
  | { type: 'success'; seq: number; data: KunListPage<T> }
  | { type: 'failure'; seq: number; message: string }
  | { type: 'removeLocal'; ids: readonly number[] }
  | { type: 'patchLocal'; id: number; patch: Partial<T> }
  | { type: 'insertLocal'; item: T; at: 'start' | 'end' }
  | { type: 'select'; op: 'toggle'; id: number; selected: boolean }
  | { type: 'select'; op: 'togglePage' }
  | { type: 'select'; op: 'replace'; ids: readonly number[] }
  | { type: 'select'; op: 'clear' }

const EMPTY_SELECTION: ReadonlySet<number> = new Set()

export const kunInitList = <T, Q extends KunListQuery<Q>>(
  config: KunListConfig<T>,
  query: Q,
  initial?: KunListPage<T>
): KunListState<T, Q> => {
  const base: KunListState<T, Q> = {
    query,
    epoch: 0,
    itemsEpoch: 0,
    seq: 0,
    request: null,
    status: 'ready',
    items: initial?.items ?? [],
    total: initial?.total ?? 0,
    loadedPage: query.page,
    hasMore: initial ? query.page * query.limit < initial.total : false,
    error: null,
    selected: EMPTY_SELECTION
  }
  // 有 SSR 首屏数据时首屏不请求 (#85、C58)
  return initial ? base : issue(base, 'replace', false)
}

const issue = <T, Q extends KunListQuery<Q>>(
  state: KunListState<T, Q>,
  mode: KunListMode,
  background: boolean,
  page = state.query.page
): KunListState<T, Q> => {
  const seq = state.seq + 1
  const request = { seq, query: { ...state.query, page }, mode, background }
  return background
    ? { ...state, seq, request }
    : { ...state, seq, request, status: 'loading', error: null }
}

const navigate = <T, Q extends KunListQuery<Q>>(
  state: KunListState<T, Q>,
  query: Q
): KunListState<T, Q> =>
  issue({ ...state, query, epoch: state.epoch + 1 }, 'replace', false)

const isSelectableOf =
  <T>(config: KunListConfig<T>) =>
  (item: T) =>
    config.isSelectable ? config.isSelectable(item) : true

const selectableIds = <T>(config: KunListConfig<T>, items: readonly T[]) =>
  items.filter(isSelectableOf(config)).map(config.getId)

const pruneSelection = <T>(
  config: KunListConfig<T>,
  selected: ReadonlySet<number>,
  items: readonly T[]
) => {
  if (!selected.size) {
    return selected
  }
  const keep = new Set(selectableIds(config, items))
  const next = new Set([...selected].filter((id) => keep.has(id)))
  return next.size === selected.size ? selected : next
}

const withoutIds = (
  selected: ReadonlySet<number>,
  ids: ReadonlySet<number>
) => {
  const next = new Set([...selected].filter((id) => !ids.has(id)))
  return next.size === selected.size ? selected : next
}

// 下一页与已加载的行重叠时 (本地插入或他人并发发布让 offset 漂移), 以本地为准 (#22、#88)
const mergePage = <T>(
  config: KunListConfig<T>,
  mode: KunListMode,
  prev: T[],
  incoming: T[]
) => {
  if (mode === 'replace') {
    return incoming
  }
  const loaded = new Set(prev.map(config.getId))
  const fresh = incoming.filter((item) => !loaded.has(config.getId(item)))
  return mode === 'append' ? [...prev, ...fresh] : [...fresh, ...prev]
}

export const kunShouldAutoLoad = <T, Q extends KunListQuery<Q>>(
  state: KunListState<T, Q>
) => state.status === 'ready' && state.request === null && state.hasMore

export type KunRemovalPlan = 'back' | 'refill' | 'none'

// total 取本地递减之前的值 (删行前与服务端一致的总数), removed 只数本页里确实删掉的行
export const kunPlanAfterRemoval = ({
  policy,
  total,
  page,
  limit,
  listLength,
  removed
}: {
  policy: NonNullable<KunListConfig<unknown>['afterRemove']>
  total: number
  page: number
  limit: number
  listLength: number
  removed: number
}): KunRemovalPlan => {
  if (policy === 'none' || removed === 0) {
    return 'none'
  }
  // 本页被抽空且不在第 1 页: 退一页走正常请求 (#24)
  if (removed >= listLength && page > 1) {
    return 'back'
  }
  if (policy === 'alwaysRefill') {
    return 'refill'
  }
  return kunShouldBackfillDeletedRow(total, page, limit) ? 'refill' : 'none'
}

// 批量操作的目标: 只取当前查询下可见且可选的行。陈旧数据 (新查询还没落地) 一律不算
export const kunVisibleSelection = <T, Q extends KunListQuery<Q>>(
  config: KunListConfig<T>,
  state: KunListState<T, Q>
): ReadonlySet<number> => {
  if (state.itemsEpoch !== state.epoch || !state.selected.size) {
    return EMPTY_SELECTION
  }
  return new Set(
    selectableIds(config, state.items).filter((id) => state.selected.has(id))
  )
}

export const kunIsPageSelected = <T, Q extends KunListQuery<Q>>(
  config: KunListConfig<T>,
  state: KunListState<T, Q>
) => {
  if (state.itemsEpoch !== state.epoch) {
    return false
  }
  const ids = selectableIds(config, state.items)
  return ids.length > 0 && ids.every((id) => state.selected.has(id))
}

export const kunReduceList = <T, Q extends KunListQuery<Q>>(
  config: KunListConfig<T>
) => {
  const clamp = config.clamp ?? 'none'
  const afterRemove = config.afterRemove ?? 'none'

  const reduce = (
    state: KunListState<T, Q>,
    event: KunListEvent<T, Q>
  ): KunListState<T, Q> => {
    switch (event.type) {
      case 'setQuery': {
        const keys = Object.keys(event.patch) as (keyof Omit<Q, 'page'>)[]
        if (
          keys.every((key) => Object.is(state.query[key], event.patch[key]))
        ) {
          return state
        }
        return navigate(state, { ...state.query, ...event.patch, page: 1 })
      }
      case 'setPage': {
        if (event.page === state.query.page) {
          return state
        }
        return navigate(state, { ...state.query, page: event.page })
      }
      case 'refresh': {
        // 后台刷新不能顶掉还没落地的前台请求, 否则 loading 等不到能让它归位的应答: 并成一次前台重发
        const background =
          (event.background ?? false) &&
          !(state.request && !state.request.background)
        return issue(state, 'replace', background)
      }
      case 'loadMore': {
        if (!kunShouldAutoLoad(state)) {
          return state
        }
        return issue(
          state,
          config.grow ?? 'append',
          false,
          state.loadedPage + 1
        )
      }
      case 'success': {
        const { request } = state
        if (!request || request.seq !== event.seq) {
          return state
        }
        const { data } = event
        const page = request.query.page
        if (clamp === 'toLastPage' && request.mode === 'replace') {
          const lastPage = Math.max(
            1,
            Math.ceil(data.total / request.query.limit)
          )
          if (page > lastPage) {
            // 越界页的应答 (空列表) 照样写入, 不留已删的旧行可操作 (881954d5); 选中集不剪,
            // 留给钳制后那一页落地 (admin-clamp-frame)。钳制是带请求的转移, 不会停在骨架
            return navigate(
              {
                ...state,
                request: null,
                items: data.items,
                itemsEpoch: state.epoch,
                total: data.total
              },
              { ...state.query, page: lastPage }
            )
          }
        }
        const items = mergePage(config, request.mode, state.items, data.items)
        return {
          ...state,
          request: null,
          status: 'ready',
          error: null,
          items,
          itemsEpoch: state.epoch,
          total: data.total,
          loadedPage: page,
          hasMore: page * request.query.limit < data.total,
          selected: pruneSelection(config, state.selected, items)
        }
      }
      case 'failure': {
        const { request } = state
        if (!request || request.seq !== event.seq) {
          return state
        }
        if (request.background) {
          return { ...state, request: null }
        }
        const error = { seq: event.seq, message: event.message }
        if (state.itemsEpoch === state.epoch) {
          // 页码与已加载的行不动: 无限列表因 status 不是 ready 而停止自动加载 (#23 失败即停)
          return { ...state, request: null, status: 'error', error }
        }
        // 查询已经变了, 手里的行属于旧查询, 不能留在新查询的标题或页码下供操作 (P29-05)
        return {
          ...state,
          request: null,
          status: 'error',
          error,
          items: [],
          itemsEpoch: state.epoch,
          selected: EMPTY_SELECTION
        }
      }
      case 'removeLocal': {
        const ids = new Set(event.ids)
        const selected = withoutIds(state.selected, ids)
        // 新查询还没落地时手里的行属于旧查询: 拿旧页的行数对新页码做退页会覆盖用户的翻页,
        // 只剔除选中, 删掉的行由新查询的应答自然排除
        if (state.itemsEpoch !== state.epoch) {
          return selected === state.selected ? state : { ...state, selected }
        }
        const removed = state.items.filter((item) =>
          ids.has(config.getId(item))
        ).length
        const plan = kunPlanAfterRemoval({
          policy: afterRemove,
          total: state.total,
          page: state.query.page,
          limit: state.query.limit,
          listLength: state.items.length,
          removed
        })
        if (plan === 'back') {
          return navigate(
            { ...state, selected },
            { ...state.query, page: state.query.page - 1 }
          )
        }
        if (!removed) {
          return selected === state.selected ? state : { ...state, selected }
        }
        const next = {
          ...state,
          selected,
          items: state.items.filter((item) => !ids.has(config.getId(item))),
          total: Math.max(0, state.total - removed)
        }
        return plan === 'refill'
          ? reduce(next, { type: 'refresh', background: true })
          : next
      }
      case 'patchLocal': {
        const index = state.items.findIndex(
          (item) => config.getId(item) === event.id
        )
        if (index < 0) {
          return state
        }
        const items = [...state.items]
        items[index] = { ...items[index], ...event.patch }
        // 改完之后不再可选的行 (例如已改判的审核任务) 退出选中集
        const selected = isSelectableOf(config)(items[index])
          ? state.selected
          : withoutIds(state.selected, new Set([event.id]))
        return { ...state, items, selected }
      }
      case 'insertLocal': {
        const id = config.getId(event.item)
        const exists = state.items.some((item) => config.getId(item) === id)
        const rest = exists
          ? state.items.filter((item) => config.getId(item) !== id)
          : state.items
        return {
          ...state,
          items:
            event.at === 'start'
              ? [event.item, ...rest]
              : [...rest, event.item],
          total: exists ? state.total : state.total + 1
        }
      }
      case 'select': {
        switch (event.op) {
          case 'toggle': {
            if (state.selected.has(event.id) === event.selected) {
              return state
            }
            const selected = new Set(state.selected)
            if (event.selected) {
              selected.add(event.id)
            } else {
              selected.delete(event.id)
            }
            return { ...state, selected }
          }
          case 'togglePage': {
            const ids = selectableIds(config, state.items)
            const selected = new Set(state.selected)
            const unselect = kunIsPageSelected(config, state)
            ids.forEach((id) =>
              unselect ? selected.delete(id) : selected.add(id)
            )
            return { ...state, selected }
          }
          case 'replace':
            return { ...state, selected: new Set(event.ids) }
          case 'clear':
            return state.selected.size
              ? { ...state, selected: EMPTY_SELECTION }
              : state
        }
      }
    }
  }

  return reduce
}

// 单个键对应单份数据的取数 (统计、联想、建议): 只让当前键的应答落地。data 与 dataKey 一起落地,
// 宿主据此判断屏幕上的数据属于哪个键, 不会出现「标题是新键、数字是旧键」
export interface KunKeyedState<K, D> {
  key: K
  seq: number
  request: { seq: number; key: K } | null
  status: KunListStatus
  data: D | null
  dataKey: K | null
  error: { seq: number; message: string } | null
}

export type KunKeyedEvent<K, D> =
  | { type: 'setKey'; key: K }
  | { type: 'success'; seq: number; data: D }
  | { type: 'failure'; seq: number; message: string }

export const kunInitKeyed = <K, D>(key: K): KunKeyedState<K, D> => ({
  key,
  seq: 1,
  request: { seq: 1, key },
  status: 'loading',
  data: null,
  dataKey: null,
  error: null
})

export const kunReduceKeyed = <K, D>(
  state: KunKeyedState<K, D>,
  event: KunKeyedEvent<K, D>
): KunKeyedState<K, D> => {
  switch (event.type) {
    case 'setKey': {
      if (Object.is(event.key, state.key)) {
        return state
      }
      const seq = state.seq + 1
      return {
        ...state,
        key: event.key,
        seq,
        request: { seq, key: event.key },
        status: 'loading',
        error: null
      }
    }
    case 'success': {
      if (!state.request || state.request.seq !== event.seq) {
        return state
      }
      return {
        ...state,
        request: null,
        status: 'ready',
        data: event.data,
        dataKey: state.request.key,
        error: null
      }
    }
    case 'failure': {
      if (!state.request || state.request.seq !== event.seq) {
        return state
      }
      return {
        ...state,
        request: null,
        status: 'error',
        error: { seq: event.seq, message: event.message }
      }
    }
  }
}
