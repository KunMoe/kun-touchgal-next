import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { kunListItemHandler } from '~/app/api/utils/render/listItemHandler'

// 这个处理器只是把「列表是松是紧」的结论按列表记下来, 输出必须与上游的处理器相同
const upstream = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeStringify)
  .freeze()

const cached = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { handlers: { listItem: kunListItemHandler } })
  .use(rehypeStringify)
  .freeze()

describe('kunListItemHandler', () => {
  it.each([
    ['紧凑列表', '- a\n- b\n- c'],
    ['松散列表', '- a\n\n- b\n\n- c'],
    ['只有一项里有两段', '- a\n- b\n\n  第二段\n- c'],
    ['空列表项', '-\n-\n-'],
    ['有序列表', '1. a\n2. b\n3. c'],
    ['从 5 开始的有序列表', '5. a\n6. b'],
    ['任务列表', '- [x] 做完\n- [ ] 没做\n- 普通项'],
    ['只有勾选框的任务项', '- [x]\n- [ ]'],
    ['嵌套: 外紧内松', '- a\n  - b\n\n  - c\n- d'],
    ['嵌套: 外松内紧', '- a\n\n  - b\n  - c\n\n- d'],
    ['列表项里的引用与代码', '- > 引用\n- ```\n  code\n  ```\n- 末项'],
    ['引用里的列表', '> - a\n> - b'],
    ['相邻的两个列表', '- a\n- b\n\n* c\n\n* d'],
    ['脚注定义里的列表', '[^a]: - x\n    - y\n\n正文[^a]']
  ])('%s的输出与上游相同', (_name, markdown) => {
    expect(String(cached.processSync(markdown))).toBe(
      String(upstream.processSync(markdown))
    )
  })

  // 解析器总会给列表项标上松紧; 别的来源造出来的树可以不标, 这时上游看项内有几块
  it('列表项没标松紧时按项内的块数判断, 与上游相同', () => {
    const paragraph = (value: string) => ({
      type: 'paragraph',
      children: [{ type: 'text', value }]
    })
    const tree = () => ({
      type: 'root',
      children: [
        {
          type: 'list',
          children: [
            { type: 'listItem', children: [paragraph('a')] },
            { type: 'listItem', children: [paragraph('b'), paragraph('c')] }
          ]
        },
        {
          type: 'list',
          children: [{ type: 'listItem', children: [paragraph('d')] }]
        }
      ]
    })

    expect(cached.stringify(cached.runSync(tree() as never))).toBe(
      upstream.stringify(upstream.runSync(tree() as never))
    )
  })
})
