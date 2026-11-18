import { remarkStringifyOptionsCtx } from '@milkdown/core'
import { listItemSchema } from '@milkdown/preset-commonmark'
import { extendListItemSchemaForTask } from '@milkdown/preset-gfm'
import type { Ctx } from '@milkdown/ctx'

type ListItemSchemaFactory = Parameters<
  Parameters<typeof listItemSchema.extendSchema>[0]
>[0]

// 列表项的第一块不是段落时 (引用、标题、嵌套列表、代码块、短代码), 文档结构要求
// 编辑器在它前面补一个空段落。空段落默认写成 `<br />`, 而紧凑列表里它与下一块之间
// 没有空行: 发布端把 `<br />` 连同下一行读成一个 HTML 块, 原始 HTML 又不输出, 于是
// 保存一次那一块就从页面上消失。这个空段落是编辑器自己补的, 写回时不带它
const withoutPaddingParagraph =
  (createSchema: ListItemSchemaFactory): ListItemSchemaFactory =>
  (ctx) => {
    const schema = createSchema(ctx)
    return {
      ...schema,
      toMarkdown: {
        match: schema.toMarkdown.match,
        runner: (state, node) => {
          const first = node.firstChild
          const padded =
            node.childCount > 1 &&
            first?.type.name === 'paragraph' &&
            first.content.size === 0

          return schema.toMarkdown.runner(
            state,
            padded ? node.copy(node.content.cut(first.nodeSize)) : node
          )
        }
      }
    }
  }

// 编辑器把文档写回 markdown 时的两处修正。编辑器与往返测试 (markdownRoundTrip.test.ts)
// 用的是同一个函数
export const configureKunWriteBack = (ctx: Ctx) => {
  // GFM 预设为任务列表另起了一份列表项定义并顶替原来的, 两份都要包
  ctx.update(listItemSchema.key, withoutPaddingParagraph)
  ctx.update(extendListItemSchemaForTask.key, withoutPaddingParagraph)

  // 尖括号自动链接 `<https://…>` 里的字符都是字面的, 反斜杠不是转义。序列化器却照
  // 正文的规则转义其中的文字: 地址里只要有一个反斜杠, 每保存一次就翻一倍, 发布出来
  // 的链接跟着变。自动链接里的文字原样写回
  ctx.update(remarkStringifyOptionsCtx, (options) => {
    const writeText = options.handlers?.text
    if (!writeText) {
      return options
    }
    return {
      ...options,
      handlers: {
        ...options.handlers,
        text: (node, parent, state, info) =>
          state.stack.includes('autolink')
            ? node.value
            : writeText(node, parent, state, info)
      }
    }
  })
}
