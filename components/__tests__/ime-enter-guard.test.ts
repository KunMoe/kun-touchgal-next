import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 输入法选字时按回车确认候选, 同样会触发 key 为 'Enter' 的 keydown, 不加守卫就会把
// 没输完的内容发出去 / 加成别名 / 拿去搜索. 两个条件缺一不可: 多数浏览器的确认回车
// isComposing 为 true; Safari 先送达 compositionend, 轮到 keydown 时 isComposing
// 已复位, 只剩 keyCode 229 可辨. HeroUI Input / react-aria 不会代为过滤
const FILES = [
  'message/chat/ChatInput.tsx',
  'edit/create/AliasInput.tsx',
  'edit/rewrite/AliasManager.tsx',
  'company/form/ArrayAdder.tsx',
  'company/SearchCompanies.tsx',
  'tag/CreateTagModal.tsx',
  'tag/detail/EditTagModal.tsx',
  'tag/SearchTag.tsx',
  'search/Input.tsx'
]

describe('回车提交的输入框带输入法守卫', () => {
  it.each(FILES)('%s', (file) => {
    const source = readFileSync(
      fileURLToPath(new URL(`../${file}`, import.meta.url)),
      'utf-8'
    )

    expect(source).toContain('nativeEvent.isComposing')
    expect(source).toContain('keyCode === 229')
  })
})
