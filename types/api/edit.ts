// /edit/rewrite/[uniqueId] 的表单基线: 页面直接读库得到, 不经详情页的 Redis 读缓存
export interface GalgameRewriteInitial {
  id: number
  uniqueId: string
  name: string
  introduction: string
  released: string
  contentLimit: string
  // 按 patch_alias.id 升序, 即上次保存时的顺序
  alias: string[]
  externalIds: {
    vndbId: string
    vndbRelationId: string
    bangumiId: string
    steamId: string
    dlsiteCode: string
  }
  // 现存标签带 id: 表单按 id 提交要移除的, 不再把名字列表当作全集回传
  tags: { id: number; name: string }[]
  // 读到基线时这些字段的指纹, 提交时原样带回, 服务端据此发现期间别人的修改
  baseFingerprint: string
}
