export interface PatchFormDataShape {
  name: string
  vndbId: string
  vndbRelationId: string
  bangumiId: string
  steamId: string
  dlsiteCode: string
  dlsiteCircleName: string
  dlsiteCircleLink: string
  vndbTags: string[]
  vndbDevelopers: string[]
  bangumiTags: string[]
  bangumiDevelopers: string[]
  steamTags: string[]
  steamDevelopers: string[]
  dlsiteTags: string[]
  alias: string[]
  tag: string[]
  released: string
}

// 表单 store 唯一的写接口: 只收「要改的字段」, 或由最新状态算出要改字段的函数。
// 不提供整对象写入: await 之后拿点击时刻的快照整份回写, 会抹掉请求期间的输入与
// 另一路抓取的结果。函数在调用时同步执行一次
export type KunFormUpdate<T> = (
  patch: Partial<T> | ((prev: T) => Partial<T>)
) => void
