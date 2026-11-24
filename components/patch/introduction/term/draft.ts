// 详情页标签 / 会社关联编辑器的草稿: 纯 TS, 不依赖 React, 在 node 环境的 vitest 下测。
// 草稿是两份「id -> 对象」: base 是服务端最近一次给出的关联列表, desired 是用户想要的关联
// 集合。勾选态只看 desired.has(id), 与加载了哪一页候选无关; 选中项存的是对象本身, 回显不必
// 回候选页反查 (P27-01 / P27-02 都出自「id 数组 + 候选页反查」)
export interface TermItem {
  id: number
  name: string
  count: number
}

export interface TermDraft<T extends TermItem> {
  base: ReadonlyMap<number, T>
  desired: ReadonlyMap<number, T>
}

export type TermDraftAction<T extends TermItem> =
  | { type: 'open'; items: readonly T[] }
  | { type: 'toggle'; item: T; checked: boolean }
  | { type: 'rebase'; items: readonly T[] }

const toMap = <T extends TermItem>(items: readonly T[]) =>
  new Map(items.map((item) => [item.id, item]))

export const emptyTermDraft = <T extends TermItem>(): TermDraft<T> => ({
  base: new Map(),
  desired: new Map()
})

// add: 想要却还没关联的; remove: 已关联却不想要的。都按草稿里的先后顺序
export const diffTermDraft = <T extends TermItem>(
  draft: TermDraft<T>
): { add: number[]; remove: number[] } => ({
  add: [...draft.desired.keys()].filter((id) => !draft.base.has(id)),
  remove: [...draft.base.keys()].filter((id) => !draft.desired.has(id))
})

export const reduceTermDraft = <T extends TermItem>(
  draft: TermDraft<T>,
  action: TermDraftAction<T>
): TermDraft<T> => {
  switch (action.type) {
    case 'open': {
      const base = toMap(action.items)
      return { base, desired: new Map(base) }
    }
    case 'toggle': {
      const desired = new Map(draft.desired)
      if (action.checked) {
        desired.set(action.item.id, action.item)
      } else {
        desired.delete(action.item.id)
      }
      return { base: draft.base, desired }
    }
    case 'rebase': {
      // 写请求成功后用服务端回传的权威列表做新的 base, 只把尚未落库的差量留在草稿里:
      // 已落库的那一步不会重发, 计数换成最新的; 别人在此期间加上的关联用户没动过, 留着
      const { add, remove } = diffTermDraft(draft)
      const base = toMap(action.items)
      const desired = new Map(base)
      for (const id of add) {
        const item = base.get(id) ?? draft.desired.get(id)
        if (item) {
          desired.set(id, item)
        }
      }
      for (const id of remove) {
        desired.delete(id)
      }
      return { base, desired }
    }
  }
}

// 搜索框为空时的列表: 先列已关联与已勾选的 (base 的顺序在前, 新勾选的按勾选先后), 取消勾选
// 的已关联项留在原位显示为未勾选, 不会从列表里消失; 再接上其余候选。hiddenIds (屏蔽的标签)
// 一律不显示, 它们留在 desired 里, 用户碰不到, 也就不会进差量
export const listForEmptyQuery = <T extends TermItem>(
  draft: TermDraft<T>,
  candidates: readonly T[],
  hiddenIds: readonly number[] = []
): T[] => {
  const hidden = new Set(hiddenIds)
  const listed = new Map<number, T>()
  for (const [id, item] of draft.base) {
    listed.set(id, draft.desired.get(id) ?? item)
  }
  for (const [id, item] of draft.desired) {
    if (!listed.has(id)) {
      listed.set(id, item)
    }
  }
  for (const item of candidates) {
    if (!listed.has(item.id)) {
      listed.set(item.id, item)
    }
  }
  return [...listed.values()].filter((item) => !hidden.has(item.id))
}

// 有搜索词时原样显示搜索结果, 只剔除屏蔽项
export const listForSearch = <T extends TermItem>(
  results: readonly T[],
  hiddenIds: readonly number[] = []
): T[] => {
  const hidden = new Set(hiddenIds)
  return results.filter((item) => !hidden.has(item.id))
}
