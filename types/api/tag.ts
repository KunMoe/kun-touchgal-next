export interface Tag {
  id: number
  name: string
  count: number
  alias: string[]
}

export interface TagDetail extends Tag {
  introduction: string
  created: string | Date
  // 建标签的账号已删除时为 null
  user: KunUser | null
}
