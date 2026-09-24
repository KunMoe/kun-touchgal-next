import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CompanyList } from '~/components/company/CompanyList'
import { TagList } from '~/components/tag/TagList'
import type { ReactElement } from 'react'

// 会社 / 标签列表按 count 降序排名, 必须是 SSR 即可见的文档流 CSS 网格:
// JS 瀑布流在测量前把卡片渲染成 absolute + opacity:0 且容器零高, 水合后撑开把
// 分页器和页脚推出视口 (/company CLS 0.14-0.20); 瀑布流还会打乱行内排名顺序
const items = [
  { id: 1, name: 'kun-a', count: 3, alias: ['a1', 'a2'] },
  { id: 2, name: 'kun-b', count: 2, alias: [] },
  { id: 3, name: 'kun-c', count: 1, alias: ['c1'] }
]

const cases: [string, ReactElement][] = [
  [
    'CompanyList',
    createElement(CompanyList, {
      companies: items,
      loading: false,
      searching: false
    })
  ],
  [
    'TagList',
    createElement(TagList, { tags: items, loading: false, searching: false })
  ]
]

describe('会社 / 标签列表 SSR 即为可见的 CSS 网格', () => {
  it.each(cases)('%s', (_, element) => {
    const html = renderToString(element)
    expect(html).toMatch(
      /^<div class="grid [^"]*grid-cols-\[repeat\(auto-fill,/
    )
    expect(html).not.toContain('opacity:0')
    expect(html).not.toContain('position:absolute')
    for (const { name } of items) {
      expect(html).toContain(name)
    }
  })
})
