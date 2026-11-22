import { describe, expect, it } from 'vitest'
import {
  kunInitKeyed,
  kunInitList,
  kunIsPageSelected,
  kunPlanAfterRemoval,
  kunReduceKeyed,
  kunReduceList,
  kunShouldAutoLoad,
  kunVisibleSelection,
  type KunListConfig,
  type KunListEvent,
  type KunListState
} from '~/utils/list/kunListMachine'
import { kunShouldBackfillDeletedRow } from '~/utils/pagination'

interface Row {
  id: number
  status: number
  note?: string
}

interface Query {
  page: number
  limit: number
  search: string
}

const row = (id: number, status = 0): Row => ({ id, status })
const rows = (...ids: number[]) => ids.map((id) => row(id))
const ids = (state: KunListState<Row, Query>) =>
  state.items.map((item) => item.id)

const admin: KunListConfig<Row> = {
  getId: (item) => item.id,
  clamp: 'toLastPage',
  afterRemove: 'refillIfNext'
}

const run = (
  config: KunListConfig<Row>,
  state: KunListState<Row, Query>,
  ...events: KunListEvent<Row, Query>[]
) => events.reduce(kunReduceList<Row, Query>(config), state)

// 起点: 首屏 (第 page 页) 已由 SSR 下发
const seeded = (
  config: KunListConfig<Row>,
  page: number,
  items: Row[],
  total: number
) => kunInitList(config, { page, limit: 2, search: '' }, { items, total })

// 让当前请求以 data 落地
const land = (
  config: KunListConfig<Row>,
  state: KunListState<Row, Query>,
  items: Row[],
  total: number
) =>
  run(config, state, {
    type: 'success',
    seq: state.request!.seq,
    data: { items, total }
  })

describe('首屏与请求的发出', () => {
  it('有 SSR 首屏数据时不请求 (#85、C58)', () => {
    const state = seeded(admin, 1, rows(1, 2), 5)
    expect(state.request).toBeNull()
    expect(state.status).toBe('ready')
  })

  it('没有首屏数据时初始即带一次前台请求', () => {
    const state = kunInitList(admin, { page: 1, limit: 2, search: '' })
    expect(state.status).toBe('loading')
    expect(state.request).toMatchObject({ seq: 1, mode: 'replace' })
  })

  it('改筛选回到第 1 页并发请求; 值都没变时什么都不做 (宿主的同步 effect 在挂载时不重取)', () => {
    const start = run(admin, seeded(admin, 3, rows(5, 6), 10))
    expect(run(admin, start, { type: 'setQuery', patch: { search: '' } })).toBe(
      start
    )
    const next = run(admin, start, { type: 'setQuery', patch: { search: 'a' } })
    expect(next.query).toEqual({ page: 1, limit: 2, search: 'a' })
    expect(next.status).toBe('loading')
    expect(next.request?.query).toEqual({ page: 1, limit: 2, search: 'a' })
  })

  it('翻到当前页不发请求', () => {
    const start = seeded(admin, 2, rows(3, 4), 10)
    expect(run(admin, start, { type: 'setPage', page: 2 })).toBe(start)
  })
})

describe('只有最新请求落地 (user-side-pagination-stale-guard、P29-03)', () => {
  it('翻页期间旧请求的应答被丢弃', () => {
    const toPage2 = run(admin, seeded(admin, 1, rows(1, 2), 10), {
      type: 'setPage',
      page: 2
    })
    const oldSeq = toPage2.request!.seq
    const toPage3 = run(admin, toPage2, { type: 'setPage', page: 3 })
    const late = run(admin, toPage3, {
      type: 'success',
      seq: oldSeq,
      data: { items: rows(3, 4), total: 10 }
    })
    expect(late).toBe(toPage3)
    expect(land(admin, late, rows(5, 6), 10).query.page).toBe(3)
  })

  it('同一序号的应答只落地一次 (StrictMode 下 effect 会把同一请求发两遍)', () => {
    const start = run(admin, seeded(admin, 1, rows(1, 2), 10), {
      type: 'refresh'
    })
    const seq = start.request!.seq
    const once = land(admin, start, rows(1, 2), 10)
    const twice = run(admin, once, {
      type: 'success',
      seq,
      data: { items: rows(9), total: 1 }
    })
    expect(twice).toBe(once)
  })

  it('不变量: 换了查询就换了请求, 序号匹配即查询未变', () => {
    let state = seeded(admin, 1, rows(1, 2), 10)
    for (const event of [
      { type: 'setPage', page: 2 },
      { type: 'setQuery', patch: { search: 'x' } },
      { type: 'refresh', background: true },
      { type: 'setPage', page: 3 }
    ] as KunListEvent<Row, Query>[]) {
      const before = state.epoch
      state = run(admin, state, event)
      if (state.epoch !== before) {
        expect(state.request?.query.page).toBe(state.query.page)
      }
    }
  })
})

describe('写后刷新取当前查询 (P22-02、08-06 缺陷 ①)', () => {
  it('批量结束后的刷新请求的是此刻的页码与筛选, 不是点击批量时的', () => {
    const atClick = seeded(admin, 2, rows(3, 4), 10)
    const navigated = run(
      admin,
      atClick,
      { type: 'setPage', page: 4 },
      { type: 'setQuery', patch: { search: 'late' } }
    )
    const refreshed = run(admin, navigated, { type: 'refresh' })
    expect(refreshed.request?.query).toEqual({
      page: 1,
      limit: 2,
      search: 'late'
    })
  })

  it('后台刷新不顶掉还没落地的前台请求, 并成一次前台重发', () => {
    const loading = run(admin, seeded(admin, 1, rows(1, 2), 10), {
      type: 'setPage',
      page: 2
    })
    const merged = run(admin, loading, { type: 'refresh', background: true })
    expect(merged.request?.background).toBe(false)
    expect(merged.status).toBe('loading')
    const failed = run(admin, merged, {
      type: 'failure',
      seq: merged.request!.seq,
      message: '失败'
    })
    expect(failed.status).toBe('error')
  })
})

describe('后台请求的三条语义 (admin-local-row-removal-silent-refill)', () => {
  const ready = run(admin, seeded(admin, 1, rows(1, 2), 10), {
    type: 'refresh',
    background: true
  })

  it('不切 loading', () => {
    expect(ready.status).toBe('ready')
    expect(ready.request?.background).toBe(true)
  })

  it('失败时什么都不做 (不报错, 不动列表)', () => {
    const failed = run(admin, ready, {
      type: 'failure',
      seq: ready.request!.seq,
      message: '失败'
    })
    expect(failed.status).toBe('ready')
    expect(failed.error).toBeNull()
    expect(ids(failed)).toEqual([1, 2])
    expect(failed.request).toBeNull()
  })

  it('不清已有的错误', () => {
    const errored = run(admin, seeded(admin, 1, rows(1, 2), 10), {
      type: 'refresh'
    })
    const withError = run(admin, errored, {
      type: 'failure',
      seq: errored.request!.seq,
      message: '失败'
    })
    const silent = run(admin, withError, { type: 'refresh', background: true })
    expect(silent.error?.message).toBe('失败')
    expect(silent.status).toBe('error')
  })
})

describe('越界页钳制 (admin-clamp-frame-flash-skeleton-guard、881954d5)', () => {
  it('越界应答转到末页并必发下一次请求, 钳制帧保持 loading 不画空态', () => {
    const loading = run(admin, seeded(admin, 3, rows(5, 6), 6), {
      type: 'refresh'
    })
    const clamped = land(admin, loading, [], 3)
    expect(clamped.query.page).toBe(2)
    expect(clamped.status).toBe('loading')
    expect(clamped.request?.query.page).toBe(2)
    expect(clamped.request?.background).toBe(false)
  })

  it('越界的空应答照样写入, 已删的旧行不留着可操作', () => {
    const loading = run(admin, seeded(admin, 3, rows(5, 6), 6), {
      type: 'refresh',
      background: true
    })
    const clamped = land(admin, loading, [], 3)
    expect(clamped.items).toEqual([])
    expect(clamped.total).toBe(3)
    expect(kunVisibleSelection(admin, clamped).size).toBe(0)
  })

  it('钳制帧不剪选中集, 留给钳制后那一页落地', () => {
    const selected = run(
      admin,
      seeded(admin, 3, rows(5, 6), 6),
      { type: 'select', op: 'replace', ids: [4] },
      { type: 'refresh' }
    )
    const clamped = land(admin, selected, [], 4)
    expect([...clamped.selected]).toEqual([4])
    const landed = land(admin, clamped, rows(3, 4), 4)
    expect([...kunVisibleSelection(admin, landed)]).toEqual([4])
  })

  it('total 为 0 时钳回第 1 页 (admin 容器的 HEAD 口径)', () => {
    const loading = run(admin, seeded(admin, 2, rows(3), 3), {
      type: 'refresh'
    })
    expect(land(admin, loading, [], 0).query.page).toBe(1)
  })

  it('改每页条数回到第 1 页, 钳制按发出请求时的条数算', () => {
    const changed = run(admin, seeded(admin, 3, rows(5, 6), 10), {
      type: 'setQuery',
      patch: { limit: 5 }
    })
    expect(changed.query).toEqual({ page: 1, limit: 5, search: '' })
    const onPage3 = run(admin, land(admin, changed, rows(1, 2, 3, 4, 5), 15), {
      type: 'setPage',
      page: 3
    })
    // 15 条每页 5 条有 3 页; 应答说只剩 9 条, 按 5 条一页末页是 2
    expect(land(admin, onPage3, [], 9).query.page).toBe(2)
  })

  it('第 1 页的空应答不钳制', () => {
    const loading = run(admin, seeded(admin, 1, rows(1), 1), {
      type: 'refresh'
    })
    const landed = land(admin, loading, [], 0)
    expect(landed.status).toBe('ready')
    expect(landed.request).toBeNull()
  })

  it('不开钳制的列表照常落地', () => {
    const plain = { ...admin, clamp: 'none' as const }
    const loading = run(plain, seeded(plain, 3, rows(5), 5), {
      type: 'refresh'
    })
    const landed = land(plain, loading, [], 2)
    expect(landed.query.page).toBe(3)
    expect(landed.status).toBe('ready')
  })
})

describe('失败进入终态', () => {
  it('同一查询下失败保留已有的行, 只报错', () => {
    const loading = run(admin, seeded(admin, 1, rows(1, 2), 10), {
      type: 'refresh'
    })
    const failed = run(admin, loading, {
      type: 'failure',
      seq: loading.request!.seq,
      message: '网络错误'
    })
    expect(failed.status).toBe('error')
    expect(failed.error).toEqual({
      seq: loading.request!.seq,
      message: '网络错误'
    })
    expect(ids(failed)).toEqual([1, 2])
  })

  it('查询变了而请求失败: 清掉旧查询的行与选中, 不在新键下冒充 (P29-05)', () => {
    const selected = run(
      admin,
      seeded(admin, 1, rows(1, 2), 10),
      { type: 'select', op: 'replace', ids: [1] },
      { type: 'setQuery', patch: { search: 'other' } }
    )
    expect(kunVisibleSelection(admin, selected).size).toBe(0)
    const failed = run(admin, selected, {
      type: 'failure',
      seq: selected.request!.seq,
      message: '失败'
    })
    expect(failed.items).toEqual([])
    expect(failed.selected.size).toBe(0)
    expect(failed.itemsEpoch).toBe(failed.epoch)
  })

  it('新的请求清掉上一次的错误', () => {
    const loading = run(admin, seeded(admin, 1, rows(1, 2), 10), {
      type: 'refresh'
    })
    const failed = run(admin, loading, {
      type: 'failure',
      seq: loading.request!.seq,
      message: '失败'
    })
    const retry = run(admin, failed, { type: 'refresh' })
    expect(retry.error).toBeNull()
    expect(retry.status).toBe('loading')
  })
})

describe('删行之后 (admin-local-row-removal-silent-refill、#24)', () => {
  it('删行计划在全部小规模输入上符合既往裁定 (#24 退页、offset 补齐)', () => {
    // 判据照裁定原文直写, 不调实现里用的 kunShouldBackfillDeletedRow
    const expected = (
      policy: 'none' | 'refillIfNext' | 'alwaysRefill',
      total: number,
      page: number,
      limit: number,
      listLength: number,
      removed: number
    ) => {
      if (policy === 'none' || removed === 0) return 'none'
      if (removed >= listLength && page > 1) return 'back'
      if (policy === 'alwaysRefill') return 'refill'
      return total > page * limit ? 'refill' : 'none'
    }
    let checked = 0
    for (const policy of ['none', 'refillIfNext', 'alwaysRefill'] as const) {
      for (let total = 0; total <= 25; total += 1) {
        for (let page = 1; page <= 5; page += 1) {
          for (const limit of [1, 2, 3, 5]) {
            for (let listLength = 1; listLength <= limit; listLength += 1) {
              for (let removed = 0; removed <= listLength; removed += 1) {
                expect(
                  kunPlanAfterRemoval({
                    policy,
                    total,
                    page,
                    limit,
                    listLength,
                    removed
                  })
                ).toBe(
                  expected(policy, total, page, limit, listLength, removed)
                )
                checked += 1
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10000)
    // 实现里的谓词与裁定原文一致 (另有 utils/__tests__ 覆盖)
    expect(kunShouldBackfillDeletedRow(5, 2, 2)).toBe(true)
  })

  it('补齐判断用删行之前的 total: 下一页恰好只剩 1 行时也补齐', () => {
    // total 3、每页 2 条: 第 2 页只有 1 行, 删掉本页 1 行后它前移进本页。用递减后的 2 判断会漏补
    const removed = run(admin, seeded(admin, 1, rows(1, 2), 3), {
      type: 'removeLocal',
      ids: [1]
    })
    expect(removed.total).toBe(2)
    expect(removed.request?.background).toBe(true)
  })

  it('新查询还没落地时删行: 只剔除选中, 不拿旧页的行数退页覆盖用户的翻页', () => {
    const navigated = run(
      admin,
      seeded(admin, 3, rows(5), 5),
      { type: 'select', op: 'toggle', id: 5, selected: true },
      { type: 'setPage', page: 2 }
    )
    const removed = run(admin, navigated, { type: 'removeLocal', ids: [5] })
    expect(removed.query.page).toBe(2)
    expect(removed.request).toBe(navigated.request)
    expect(removed.selected.size).toBe(0)
  })

  it('查询的值只能是原始值 (setQuery 按 Object.is 比较, 数组会让挂载时的同步变成重取)', () => {
    // @ts-expect-error 数组不是原始值
    kunInitList<Row, { page: number; limit: number; tags: string[] }>(admin, {
      page: 1,
      limit: 2,
      tags: []
    })
  })

  it('存在下一页时本地删行并静默补齐当前查询, 不闪骨架', () => {
    const start = seeded(admin, 1, rows(1, 2), 5)
    const removed = run(admin, start, { type: 'removeLocal', ids: [1] })
    expect(ids(removed)).toEqual([2])
    expect(removed.total).toBe(4)
    expect(removed.status).toBe('ready')
    expect(removed.request).toMatchObject({
      background: true,
      query: { page: 1, limit: 2, search: '' }
    })
  })

  it('没有下一页时只删本地', () => {
    const removed = run(admin, seeded(admin, 2, rows(3, 4), 4), {
      type: 'removeLocal',
      ids: [3]
    })
    expect(ids(removed)).toEqual([4])
    expect(removed.request).toBeNull()
  })

  it('本页删空且不在第 1 页时退一页 (#24)', () => {
    const removed = run(admin, seeded(admin, 3, rows(5), 5), {
      type: 'removeLocal',
      ids: [5]
    })
    expect(removed.query.page).toBe(2)
    expect(removed.status).toBe('loading')
  })

  it('alwaysRefill: 服务端连带删除了别处的行, 没有下一页也补齐 (评论的级联回复)', () => {
    const comment = { ...admin, afterRemove: 'alwaysRefill' as const }
    const removed = run(comment, seeded(comment, 2, rows(3, 4), 4), {
      type: 'removeLocal',
      ids: [3, 99, 100]
    })
    expect(ids(removed)).toEqual([4])
    expect(removed.total).toBe(3)
    expect(removed.request?.background).toBe(true)
  })

  it('补齐换入的新行不会被批量带上 (误删的形状)', () => {
    const start = run(admin, seeded(admin, 1, rows(1, 2), 5), {
      type: 'select',
      op: 'togglePage'
    })
    const removed = run(admin, start, { type: 'removeLocal', ids: [1] })
    expect([...kunVisibleSelection(admin, removed)]).toEqual([2])
    const refilled = land(admin, removed, rows(2, 3), 4)
    expect([...kunVisibleSelection(admin, refilled)]).toEqual([2])
  })

  it('补齐期间管理员翻了页: 补齐的应答被丢弃, 不覆盖导航', () => {
    const removed = run(admin, seeded(admin, 1, rows(1, 2), 5), {
      type: 'removeLocal',
      ids: [1]
    })
    const refillSeq = removed.request!.seq
    const navigated = run(admin, removed, { type: 'setPage', page: 2 })
    const late = run(admin, navigated, {
      type: 'success',
      seq: refillSeq,
      data: { items: rows(2, 3), total: 4 }
    })
    expect(late).toBe(navigated)
  })

  it('none: 只删本地并递减 total', () => {
    const plain = { ...admin, afterRemove: 'none' as const }
    const removed = run(plain, seeded(plain, 2, rows(3), 5), {
      type: 'removeLocal',
      ids: [3]
    })
    expect(removed.items).toEqual([])
    expect(removed.total).toBe(4)
    expect(removed.request).toBeNull()
  })
})

describe('选中集只含可见且可选的行', () => {
  const report = {
    ...admin,
    isSelectable: (item: Row) => item.status === 0
  }

  it('全选当前页只选可选的行, 再按一次取消', () => {
    const start = seeded(report, 1, [row(1), row(2, 1), row(3)], 3)
    const all = run(report, start, { type: 'select', op: 'togglePage' })
    expect([...kunVisibleSelection(report, all)]).toEqual([1, 3])
    expect(kunIsPageSelected(report, all)).toBe(true)
    const none = run(report, all, { type: 'select', op: 'togglePage' })
    expect(kunVisibleSelection(report, none).size).toBe(0)
  })

  it('落地时剪掉已不在本页或已不可选的行', () => {
    const start = run(
      report,
      seeded(report, 1, [row(1), row(2), row(3)], 3),
      { type: 'select', op: 'replace', ids: [1, 2, 3] },
      { type: 'refresh' }
    )
    const landed = land(report, start, [row(1, 1), row(3)], 2)
    expect([...landed.selected]).toEqual([3])
  })

  it('就地更新后不再可选的行退出选中集 (改判后的审核任务)', () => {
    const start = run(report, seeded(report, 1, [row(1), row(2)], 2), {
      type: 'select',
      op: 'togglePage'
    })
    const patched = run(report, start, {
      type: 'patchLocal',
      id: 1,
      patch: { status: 2 }
    })
    expect([...patched.selected]).toEqual([2])
    expect(patched.items[0]).toEqual({ id: 1, status: 2 })
  })

  it('新查询还没落地时没有可见选中 (陈旧行不得作为批量目标)', () => {
    const start = run(
      report,
      seeded(report, 1, [row(1)], 1),
      { type: 'select', op: 'toggle', id: 1, selected: true },
      { type: 'setPage', page: 2 }
    )
    expect(kunVisibleSelection(report, start).size).toBe(0)
    expect(kunIsPageSelected(report, start)).toBe(false)
  })
})

describe('无限列表 (#23、#22、#88)', () => {
  const feed: KunListConfig<Row> = {
    getId: (item) => item.id,
    grow: 'append'
  }

  const first = land(
    feed,
    kunInitList(feed, { page: 1, limit: 2, search: '' }),
    rows(1, 2),
    5
  )

  it('哨兵可见时加载下一页, 页码只在成功后推进', () => {
    expect(kunShouldAutoLoad(first)).toBe(true)
    const loading = run(feed, first, { type: 'loadMore' })
    expect(loading.request?.query.page).toBe(2)
    expect(loading.loadedPage).toBe(1)
    expect(kunShouldAutoLoad(loading)).toBe(false)
    expect(run(feed, loading, { type: 'loadMore' })).toBe(loading)
    expect(land(feed, loading, rows(3, 4), 5).loadedPage).toBe(2)
  })

  it('失败即停: 页码不推进, 不再自动加载, 已加载的行保留', () => {
    const loading = run(feed, first, { type: 'loadMore' })
    const failed = run(feed, loading, {
      type: 'failure',
      seq: loading.request!.seq,
      message: '失败'
    })
    expect(failed.loadedPage).toBe(1)
    expect(ids(failed)).toEqual([1, 2])
    expect(kunShouldAutoLoad(failed)).toBe(false)
    expect(run(feed, failed, { type: 'loadMore' })).toBe(failed)
  })

  it('下一页与已加载的行重叠时按 id 剔除, 以本地为准', () => {
    const local = run(feed, first, {
      type: 'patchLocal',
      id: 2,
      patch: { note: 'local' }
    })
    const loading = run(feed, local, { type: 'loadMore' })
    const landed = land(
      feed,
      loading,
      [{ id: 2, status: 0, note: 'server' }, row(3)],
      5
    )
    expect(landed.items).toEqual([
      row(1),
      { id: 2, status: 0, note: 'local' },
      row(3)
    ])
  })

  it('prepend: 更早的一页接在前面 (私聊历史)', () => {
    const chat = { ...feed, grow: 'prepend' as const }
    const start = kunInitList(
      chat,
      { page: 1, limit: 2, search: '' },
      { items: rows(30, 31), total: 5 }
    )
    const loading = run(chat, start, { type: 'loadMore' })
    const landed = land(chat, loading, rows(28, 29, 30), 5)
    expect(ids(landed)).toEqual([28, 29, 30, 31])
  })

  it('取完即停', () => {
    const loading = run(feed, first, { type: 'loadMore' })
    const last = land(
      feed,
      run(feed, land(feed, loading, rows(3, 4), 5), { type: 'loadMore' }),
      rows(5),
      5
    )
    expect(last.hasMore).toBe(false)
    expect(kunShouldAutoLoad(last)).toBe(false)
  })

  it('本地插入去重, 只有新行才计入 total', () => {
    const inserted = run(
      feed,
      first,
      { type: 'insertLocal', item: row(9), at: 'start' },
      { type: 'insertLocal', item: { id: 9, status: 1 }, at: 'start' }
    )
    expect(ids(inserted)).toEqual([9, 1, 2])
    expect(inserted.items[0].status).toBe(1)
    expect(inserted.total).toBe(6)
  })

  it('改筛选后旧行陈旧, 新的第一页整体替换', () => {
    const toggled = run(feed, first, {
      type: 'setQuery',
      patch: { search: 'short' }
    })
    expect(toggled.itemsEpoch).not.toBe(toggled.epoch)
    expect(toggled.request?.mode).toBe('replace')
    expect(ids(land(feed, toggled, rows(7), 1))).toEqual([7])
  })
})

describe('单键取数', () => {
  it('旧键的慢应答不覆盖新键 (P29-03、P23-02)', () => {
    const first = kunInitKeyed<number, string>(1)
    const second = kunReduceKeyed(first, { type: 'setKey', key: 7 })
    const late = kunReduceKeyed(second, {
      type: 'success',
      seq: 1,
      data: 'one'
    })
    expect(late).toBe(second)
    const landed = kunReduceKeyed(late, {
      type: 'success',
      seq: 2,
      data: 'seven'
    })
    expect(landed).toMatchObject({ data: 'seven', dataKey: 7, status: 'ready' })
  })

  it('数据与它所属的键一起落地; 失败时保留上一份数据与键', () => {
    const landed = kunReduceKeyed(kunInitKeyed<number, string>(1), {
      type: 'success',
      seq: 1,
      data: 'one'
    })
    const pending = kunReduceKeyed(landed, { type: 'setKey', key: 7 })
    expect(pending).toMatchObject({
      data: 'one',
      dataKey: 1,
      status: 'loading'
    })
    const failed = kunReduceKeyed(pending, {
      type: 'failure',
      seq: pending.request!.seq,
      message: '失败'
    })
    expect(failed).toMatchObject({
      data: 'one',
      dataKey: 1,
      status: 'error',
      error: { message: '失败' }
    })
  })

  it('键没变时什么都不做', () => {
    const state = kunInitKeyed<string, number>('a')
    expect(kunReduceKeyed(state, { type: 'setKey', key: 'a' })).toBe(state)
  })
})
