import { createHash } from 'crypto'
import { visit } from 'unist-util-visit'
import type { Plugin } from 'unified'
import type { Node } from 'unist'

// 一页上同时有简介、每条评论、每条资源备注, 各自独立渲染后放进同一份文档。脚注的
// 锚点只按脚注名字生成, 两段内容都写 [^1] 就会撞 id: 后一段的脚注链接跳进前一段里,
// 排在前面的人可以让别人的脚注指向自己写的文字。
//
// 这里给每段内容的脚注锚点 (id 与指向它的链接) 插入一段由原文算出的标识。同一份
// 原文的标识不变, 落库的 HTML 与渲染缓存照常复用; 要让两段内容撞上, 得先让它们的
// 原文相同

// 上游生成的两种锚点: 脚注定义 user-content-fn-名字, 引用处 user-content-fnref-名字
const FOOTNOTE_ANCHOR = /^(#?user-content-fn(?:ref)?-)(.*)$/s

export const rehypeKunFootnoteScope: Plugin<[], Node> = () => {
  return (tree, file) => {
    let scope: string | undefined

    const scoped = (value: unknown) => {
      const match = typeof value === 'string' && FOOTNOTE_ANCHOR.exec(value)
      if (!match) {
        return value
      }
      // 没有脚注的内容 (绝大多数) 不付这次哈希
      scope ??= createHash('sha256')
        .update(String(file.value ?? ''))
        .digest('hex')
        .slice(0, 16)
      return `${match[1]}${scope}-${match[2]}`
    }

    visit(tree, 'element', (node: any) => {
      const properties = node.properties
      if (!properties) {
        return
      }
      if (properties.id !== undefined) {
        properties.id = scoped(properties.id)
      }
      if (node.tagName === 'a' && properties.href !== undefined) {
        properties.href = scoped(properties.href)
      }
    })
  }
}
