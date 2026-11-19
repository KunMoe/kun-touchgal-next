export interface Company {
  id: number
  name: string
  count: number
  alias: string[]
}

export interface CompanyDetail extends Company {
  introduction: string
  primary_language: string[]
  official_website: string[]
  parent_brand: string[]
  created: string | Date
  // 建会社的账号已删除时为 null
  user: KunUser | null
}
