import {
  Editor,
  ParserReady,
  SerializerReady,
  parserCtx,
  serializerCtx
} from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { kunMarkdownCorpus } from '~/app/api/utils/render/__tests__/fixtures/markdownCorpus'
import { renderKunMarkdown } from '~/app/api/utils/render/renderKunMarkdown'
import { kunDirectives } from '../plugins/components/kunDirectives'
import { kunLinkNode } from '../plugins/components/link/linkPlugin'
import { videoNode } from '../plugins/components/video/videoPlugin'
import type { Ctx, MilkdownPlugin } from '@milkdown/ctx'

// 可视化编辑器的 markdown 往返: 用编辑器真实的解析器、序列化器与节点定义, 把 markdown
// 读成文档再写回 markdown。不需要浏览器 —— 这两步不碰视图, 只有 milkdown 的就绪信号
// 借用了全局的事件方法, 下面给它一条事件总线即可。视图本身建不起来, create() 的失败
// 在预期之内。
//
// 守的是简介编辑的三件事: 任何内容都能打开 (P24-01), 写回的 markdown 不改变发布结果
// (P24-02), 再次打开、保存得到同样的 markdown

type Parser = (markdown: string) => {
  toString: () => string
  descendants: (
    visit: (node: { type: { name: string }; attrs: unknown }) => void
  ) => void
}
type Serializer = (doc: ReturnType<Parser>) => string

let parse: Parser
let serialize: Serializer

const GLOBAL_STUBS = [
  'document',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent'
] as const

beforeAll(async () => {
  const bus = new EventTarget()
  Object.assign(globalThis, {
    document: { body: {} },
    addEventListener: bus.addEventListener.bind(bus),
    removeEventListener: bus.removeEventListener.bind(bus),
    dispatchEvent: bus.dispatchEvent.bind(bus)
  })

  await new Promise<void>((resolve) => {
    const capture: MilkdownPlugin = (ctx: Ctx) => async () => {
      await ctx.wait(ParserReady)
      await ctx.wait(SerializerReady)
      parse = ctx.get(parserCtx) as unknown as Parser
      serialize = ctx.get(serializerCtx) as unknown as Serializer
      resolve()
    }

    Editor.make()
      .use(commonmark)
      .use(gfm)
      .use([kunDirectives].flat())
      .use([videoNode, kunLinkNode].flat())
      .use(capture)
      .create()
      .catch(() => {})
  })
})

afterAll(() => {
  for (const name of GLOBAL_STUBS) {
    Reflect.deleteProperty(globalThis, name)
  }
})

const roundTrip = (markdown: string) => serialize(parse(markdown))

const nodesOf = (markdown: string) => {
  const nodes: { name: string; attrs: unknown }[] = []
  parse(markdown).descendants((node) => {
    nodes.push({ name: node.type.name, attrs: node.attrs })
  })
  return nodes
}

const publish = async (markdown: string) =>
  (await renderKunMarkdown('introduction', markdown, { cache: false })).html

describe('普通文字里的冒号', () => {
  it.each([
    '发售时间 10:30 开始',
    '注:这个补丁很好',
    'Re:Zero 是一部作品',
    '主角 CV:花澤香菜',
    '比例 16:9 屏幕',
    'CV:花澤香菜 **粗体**',
    '比例 16:9{.wide} 屏幕'
  ])('%s 写回时不加反斜杠', (markdown) => {
    expect(roundTrip(markdown)).toBe(`${markdown}\n`)
  })

  // 旧版编辑器给冒号加过转义: 再保存一次就去掉, 显示不变
  it('存量里的 \\: 读成冒号, 写回时不再转义', () => {
    expect(roundTrip('时间 10\\:30 开始')).toBe('时间 10:30 开始\n')
    expect(roundTrip('Re\\:Zero **粗体**')).toBe('Re:Zero **粗体**\n')
  })

  it('链接地址里的冒号不被转义', () => {
    expect(roundTrip('[官网](https://a.example/x:y)')).toBe(
      '[官网](https://a.example/x:y)\n'
    )
    expect(roundTrip('见 https://a.example/x:y')).not.toContain('\\:')
  })
})

describe('视频与链接短代码', () => {
  it('成为编辑器节点, 属性是校验过的值', () => {
    expect(
      nodesOf(
        '::kun-video{src="https://a.example/v.mp4"}\n\n::kun-link{href="https://a.example" text="正版"}'
      )
    ).toEqual([
      { name: 'kun-video', attrs: { src: 'https://a.example/v.mp4' } },
      { name: 'kun-link', attrs: { href: 'https://a.example', text: '正版' } }
    ])
  })

  it.each([
    '::kun-video{src="https://a.example/v.mp4"}\n',
    '::kun-link{href="https://a.example" text="正版"}\n',
    '前言\n\n::kun-video{src="https://a.example/v.mp4"}\n\n后记\n'
  ])('%s 往返不变', (markdown) => {
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('属性不合格的不成为节点, 按原文进编辑器', () => {
    expect(
      nodesOf('::kun-link{href="javascript:alert(1)" text="x"}').map(
        (node) => node.name
      )
    ).toEqual(['paragraph', 'text'])
  })
})

// 投稿模板留下的占位短代码: 发布时不显示。编辑器要把它留住 (卡片会提示无效),
// 否则打开再保存就悄悄删掉了这一行。空属性写回时省掉 ="", 含义不变
describe('地址没填的短代码', () => {
  it.each([
    [
      '## 支持正版\n\n::kun-link{href="" text="点我前往购买"}',
      '## 支持正版\n\n::kun-link{href text="点我前往购买"}\n'
    ],
    ['::kun-video{src=""}', '::kun-video{src}\n']
  ])('%s 保留成节点, 发布时始终不显示', async (markdown, written) => {
    expect(roundTrip(markdown)).toBe(written)
    expect(roundTrip(written)).toBe(written)
    expect(await publish(written)).toBe(await publish(markdown))
    expect(await publish(markdown)).not.toContain('<div')
  })
})

describe('编辑器不认识的写法', () => {
  // 认不出的节点曾让解析抛错, 编辑区一片空白
  it.each([
    ['未注册的整行指令', '::foo{bar=1}', '\\::foo{bar=1}\n'],
    ['容器', ':::note\n内容\n:::', '\\:::note\n\n内容\n\n\\:::\n'],
    [
      '行内写法的短代码',
      '前文 :kun-video{src="/v.mp4"} 后文',
      '前文 :kun-video{src="/v.mp4"} 后文\n'
    ]
  ])('%s按原文打开, 写回后仍是原文', (_name, markdown, written) => {
    expect(roundTrip(markdown)).toBe(written)
    expect(roundTrip(written)).toBe(written)
  })
})

// 编辑器写回后发布结果会变的语料。都是既有行为, 修好之后这里的条目要删掉
const KNOWN_DIVERGENCE = new Set([
  // 列表项以短代码开头: 列表项必须以段落开头, 编辑器补一个空段落并写成 <br />;
  // 发布端把 <br /> 连同下一行读成一个 HTML 块, 而原始 HTML 不输出, 卡片随之消失
  'directive-in-list'
])

// 方言覆盖的语料 (冒号与指令) 逐条过一遍
describe.each(
  kunMarkdownCorpus
    .filter(
      (entry) =>
        entry.tags.includes('colon') || entry.tags.includes('directive')
    )
    .map((entry) => [entry.id, entry.markdown] as const)
)('语料 %s', (id, markdown) => {
  it('写回的 markdown 发布出来与原文相同', async () => {
    const same =
      (await publish(roundTrip(markdown))) === (await publish(markdown))

    expect(same).toBe(!KNOWN_DIVERGENCE.has(id))
  })

  it('再次打开、保存得到同样的 markdown', () => {
    const written = roundTrip(markdown)

    expect(roundTrip(written)).toBe(written)
  })
})
