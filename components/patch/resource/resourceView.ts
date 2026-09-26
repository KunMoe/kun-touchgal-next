// 资源 tab 的视图状态 (当前分区, 已展开下载链接的资源, 列表高度). 从 /redirect、
// 资源详情页等同文档后退回来时页面树会重新挂载, 靠它还原离开前的样子, 并在列表
// 重新请求期间按原高度占位, 浏览器按原位恢复滚动才不会被截断. 只记最近挂载的
// 那一个 patch, 放在模块里, 整页刷新即清空
interface ResourceView {
  patchId: number
  section: string
  expandedIds: Set<number>
  listHeight: number
}

let view: ResourceView = {
  patchId: 0,
  section: 'galgame',
  expandedIds: new Set(),
  listHeight: 0
}

// Next 在 popstate 事件里用 startTransition 派发后退 / 前进, React 会把这次
// transition 同步渲染完, 浏览器随后才恢复滚动; 渲染期间 window.event 仍是那个
// popstate. 页面树须重新请求 RSC 时渲染晚于事件, 这里为 false, 按新访问处理
export const canRestoreResourceView = (patchId: number) =>
  typeof window !== 'undefined' &&
  window.event?.type === 'popstate' &&
  view.patchId === patchId

// Resources 首次渲染时调用: 可还原时沿用并返回 true, 否则重置
export const enterResourceView = (patchId: number) => {
  if (canRestoreResourceView(patchId)) {
    return true
  }
  view = {
    patchId,
    section: 'galgame',
    expandedIds: new Set(),
    listHeight: 0
  }
  return false
}

export const getResourceView = () => view
