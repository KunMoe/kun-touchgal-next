import { House, Tag, type LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import { SearchTags } from '~/components/tag/SearchTag'
import { SearchCompanies } from '~/components/company/SearchCompanies'

interface TermSearchProps {
  query: string
  setQuery: (value: string) => void
  handleSearch: () => void
  searching: boolean
}

// 标签与会社编辑器只在这些地方不同: 接口路径、写请求的 id 字段、搜索框与文案。
// 文案与原先两个选择器逐字相同。只由编辑器自己导入: 分区组件 (Tag.tsx / Company.tsx) 按
// 名字传 kind, 不静态导入这里, 否则搜索框与图标会被拉回 /[id] 的入口块 (C23)
export interface PatchTermKindConfig {
  listPath: '/tag/all' | '/company/all'
  listKey: 'tags' | 'companies'
  searchPath: '/tag/search' | '/company/search'
  mutatePath: '/patch/introduction/tag' | '/patch/introduction/company'
  idField: 'tagId' | 'companyId'
  createHref: '/tag' | '/company'
  Search: ComponentType<TermSearchProps>
  Icon: LucideIcon
  text: {
    button: string
    header: string
    loading: string
    countSuffix: string
    success: string
    failure: string
    // 搜索框为空且一项都没有时的提示; 标签侧原先不提示
    empty: string | null
    footerPrompt: string
    footerLink: string
  }
}

export type PatchTermKind = 'tag' | 'company'

const PATCH_TAG_KIND: PatchTermKindConfig = {
  listPath: '/tag/all',
  listKey: 'tags',
  searchPath: '/tag/search',
  mutatePath: '/patch/introduction/tag',
  idField: 'tagId',
  createHref: '/tag',
  Search: SearchTags,
  Icon: Tag,
  text: {
    button: '更改标签',
    header: '更改这个 Galgame 的标签',
    loading: '正在获取标签数据...',
    countSuffix: '个游戏',
    success: '更改标签成功',
    failure: '更改标签失败, 请稍后重试',
    empty: null,
    footerPrompt: '没有您想要的标签? ',
    footerLink: '去创建标签'
  }
}

const PATCH_COMPANY_KIND: PatchTermKindConfig = {
  listPath: '/company/all',
  listKey: 'companies',
  searchPath: '/company/search',
  mutatePath: '/patch/introduction/company',
  idField: 'companyId',
  createHref: '/company',
  Search: SearchCompanies,
  Icon: House,
  text: {
    button: '更改所属会社',
    header: '更改这个 Galgame 的所属会社',
    loading: '正在获取会社数据...',
    countSuffix: '个 Galgame',
    success: '更改所属会社成功',
    failure: '更改所属会社失败, 请稍后重试',
    empty: '暂无已选会社，请输入关键字搜索添加',
    // 问号后是不换行空格, 与原先的 &nbsp; 相同
    footerPrompt: '没有要选择的会社?\u00a0',
    footerLink: '去创建会社'
  }
}

export const PATCH_TERM_KINDS: Record<PatchTermKind, PatchTermKindConfig> = {
  tag: PATCH_TAG_KIND,
  company: PATCH_COMPANY_KIND
}
