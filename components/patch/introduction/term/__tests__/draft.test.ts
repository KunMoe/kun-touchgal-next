import { describe, expect, it } from 'vitest'
import {
  diffTermDraft,
  emptyTermDraft,
  listForEmptyQuery,
  listForSearch,
  reduceTermDraft,
  type TermDraft,
  type TermDraftAction,
  type TermItem
} from '~/components/patch/introduction/term/draft'

const item = (id: number, count = 1): TermItem => ({
  id,
  name: `t${id}`,
  count
})

const run = (
  actions: TermDraftAction<TermItem>[],
  start: TermDraft<TermItem> = emptyTermDraft()
) => actions.reduce(reduceTermDraft, start)

const ids = (items: readonly TermItem[]) => items.map((i) => i.id)

describe('reduceTermDraft', () => {
  it('打开时用当前关联播种, 差量为空', () => {
    const draft = run([{ type: 'open', items: [item(1), item(2)] }])
    expect(diffTermDraft(draft)).toEqual({ add: [], remove: [] })
    expect([...draft.desired.keys()]).toEqual([1, 2])
  })

  it('再次打开丢弃上一次没提交的勾选', () => {
    const draft = run([
      { type: 'open', items: [item(1)] },
      { type: 'toggle', item: item(5), checked: true },
      { type: 'open', items: [item(1)] }
    ])
    expect(diffTermDraft(draft)).toEqual({ add: [], remove: [] })
  })

  it('两次搜索各勾一个, 两个都进差量, 对象都留在草稿里可回显 (P27-02)', () => {
    const fromFirstSearch = { id: 10, name: '冷门甲', count: 1 }
    const fromSecondSearch = { id: 20, name: '冷门乙', count: 2 }
    const draft = run([
      { type: 'open', items: [item(1)] },
      { type: 'toggle', item: fromFirstSearch, checked: true },
      { type: 'toggle', item: fromSecondSearch, checked: true }
    ])
    expect(diffTermDraft(draft)).toEqual({ add: [10, 20], remove: [] })
    expect(draft.desired.get(10)).toBe(fromFirstSearch)
    expect(draft.desired.get(20)).toBe(fromSecondSearch)
  })

  it('不在任何候选页里的已关联项也能取消 (P27-01)', () => {
    const rank300 = item(300)
    const draft = run([
      { type: 'open', items: [item(1), rank300] },
      { type: 'toggle', item: rank300, checked: false }
    ])
    expect(diffTermDraft(draft)).toEqual({ add: [], remove: [300] })
  })

  it('勾上又取消、取消又勾上都回到无差量', () => {
    const draft = run([
      { type: 'open', items: [item(1)] },
      { type: 'toggle', item: item(5), checked: true },
      { type: 'toggle', item: item(5), checked: false },
      { type: 'toggle', item: item(1), checked: false },
      { type: 'toggle', item: item(1), checked: true }
    ])
    expect(diffTermDraft(draft)).toEqual({ add: [], remove: [] })
  })

  it('PUT 成功、POST 失败后按回传列表校准, 只剩没落库的新增', () => {
    const draft = run([
      { type: 'open', items: [item(1), item(2)] },
      { type: 'toggle', item: item(2), checked: false },
      { type: 'toggle', item: item(7), checked: true },
      // PUT 的应答: 2 已删除
      { type: 'rebase', items: [item(1, 9)] }
    ])
    expect(diffTermDraft(draft)).toEqual({ add: [7], remove: [] })
    // 计数换成服务端的最新值
    expect(draft.base.get(1)?.count).toBe(9)
    expect(draft.desired.get(1)?.count).toBe(9)
  })

  it('全部落库后差量清空, 新增项换成服务端回传的对象', () => {
    const draft = run([
      { type: 'open', items: [item(1)] },
      { type: 'toggle', item: item(7, 1), checked: true },
      { type: 'rebase', items: [item(1), item(7, 2)] }
    ])
    expect(diffTermDraft(draft)).toEqual({ add: [], remove: [] })
    expect(draft.desired.get(7)?.count).toBe(2)
  })

  it('别人在此期间加上的关联用户没动过, 校准后保留, 不进差量', () => {
    const draft = run([
      { type: 'open', items: [item(1)] },
      { type: 'toggle', item: item(1), checked: false },
      { type: 'rebase', items: [item(1), item(8)] }
    ])
    expect(diffTermDraft(draft)).toEqual({ add: [], remove: [1] })
    expect(draft.desired.has(8)).toBe(true)
  })
})

describe('listForEmptyQuery', () => {
  it('先列已关联与已勾选的, 再接其余候选, 不重复', () => {
    const draft = run([
      { type: 'open', items: [item(1), item(2)] },
      { type: 'toggle', item: item(9), checked: true }
    ])
    const list = listForEmptyQuery(draft, [item(3), item(2), item(9), item(4)])
    expect(ids(list)).toEqual([1, 2, 9, 3, 4])
  })

  it('取消勾选的已关联项留在原位, 不从列表里消失', () => {
    const draft = run([
      { type: 'open', items: [item(1), item(2)] },
      { type: 'toggle', item: item(1), checked: false }
    ])
    const list = listForEmptyQuery(draft, [])
    expect(ids(list)).toEqual([1, 2])
    expect(draft.desired.has(1)).toBe(false)
  })

  it('屏蔽项不显示, 也不进差量', () => {
    const draft = run([{ type: 'open', items: [item(1), item(66)] }])
    const list = listForEmptyQuery(draft, [item(66), item(3)], [66])
    expect(ids(list)).toEqual([1, 3])
    expect(diffTermDraft(draft)).toEqual({ add: [], remove: [] })
  })
})

describe('listForSearch', () => {
  it('搜索结果原样显示, 只剔除屏蔽项', () => {
    expect(ids(listForSearch([item(5), item(66), item(1)], [66]))).toEqual([
      5, 1
    ])
  })
})
