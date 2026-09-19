import type { KunPatchRating } from '~/types/api/galgame'

// 评价列表是 offset 分页, 本地前插新评价 (或他人并发发布) 后服务端头部增长,
// 下一页会重叠上一页尾部; 按 id 剔除已加载的行, 碰撞时以本地为准
export const dropLoadedRatings = (
  prev: KunPatchRating[],
  incoming: KunPatchRating[]
) => {
  const loaded = new Set(prev.map((rating) => rating.id))
  return incoming.filter((rating) => !loaded.has(rating.id))
}
