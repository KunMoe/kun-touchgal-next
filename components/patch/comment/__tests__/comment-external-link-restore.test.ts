import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 评论外链 effect 会把 <a data-kun-external-link> 换成挂 KunExternalLink 的 div.
// cleanup 若只卸载 root 不放回占位, DOM 未重建时 effect 重跑就找不到占位, 链接只剩空 div:
// 开发环境 StrictMode 挂载双调用 (曾靠 useMounted 让首轮空跑掩盖), 以及已揭示的剧透评论
// 被作者取消剧透标记且内容不变时 (生产可复现)
const source = readFileSync(
  fileURLToPath(new URL('../CommentContent.tsx', import.meta.url)),
  'utf-8'
)

describe('评论外链 effect 可重复执行', () => {
  it('挂载时用 div 替换占位', () => {
    expect(source).toContain('element.replaceWith(root)')
  })

  it('cleanup 先放回占位再延迟卸载 root', () => {
    expect(source).toMatch(
      /return \(\) => \{[\s\S]*?root\.replaceWith\(element\)\)\s*window\.setTimeout\(/
    )
  })
})
