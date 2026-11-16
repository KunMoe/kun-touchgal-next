import { describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/redis', () => ({
  getKv: vi.fn(async () => null),
  setKv: vi.fn(),
  delKv: vi.fn()
}))

import { markdownToHtml } from '~/app/api/utils/render/markdownToHtml'
import { markdownToHtmlComment } from '~/app/api/utils/render/markdownToHtmlComment'
import { markdownToHtmlExtend } from '~/app/api/utils/render/markdownToHtmlExtend'
import { markdownToHtml as markdownToHtmlResourceNote } from '~/components/patch/resource/kun/markdownToHtml'

// X08-01: 四条管线曾在净化之后挂语法高亮插件。服务端的净化会剥掉 code 上的 language-*
// 类名, 插件从不上色, 却照样解析围栏 meta 里的行号区间, 并把区间逐行展开成数组:
// 一条 ```js {1-4000000} 让单次渲染多占几十 MB 堆内存, 且随区间线性增长。
// 现在管线里没有任何解释围栏 meta 的环节, 代码块按 pre > code 原样输出

const SERVER_CODE_BLOCK = '<pre><code>const a = 1\n</code></pre>'

const PIPELINES = [
  ['标准', markdownToHtml, SERVER_CODE_BLOCK],
  ['评论', markdownToHtmlComment, SERVER_CODE_BLOCK],
  ['介绍', markdownToHtmlExtend, SERVER_CODE_BLOCK],
  // 客户端渲染鲲补丁备注用的是 rehype-sanitize 默认策略, 保留语言类名
  [
    '资源备注 (客户端) ',
    markdownToHtmlResourceNote,
    '<pre><code class="language-js">const a = 1\n</code></pre>'
  ]
] as const

describe.each(PIPELINES)('%s管线的代码块', (_name, render, expected) => {
  it('围栏代码块原样输出, 不带高亮标记', async () => {
    expect(await render('```js\nconst a = 1\n```')).toBe(expected)
  })

  it('围栏 meta 里的行号区间不被解释', async () => {
    expect(await render('```js {1-4000000}\nconst a = 1\n```')).toBe(expected)
    expect(await render('```js {1} showLineNumbers\nconst a = 1\n```')).toBe(
      expected
    )
  })
})
