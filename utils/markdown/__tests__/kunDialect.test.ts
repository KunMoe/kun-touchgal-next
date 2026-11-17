import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import {
  parseKunLinkAttrs,
  parseKunVideoAttrs,
  readKunDirective,
  remarkKunDirectives
} from '~/utils/markdown/kunDialect'
import type { Node } from 'unist'
import type { KunDirectiveOptions } from '~/utils/markdown/kunDialect'

interface TreeNode extends Node {
  value?: string
  children?: TreeNode[]
}

const transform = (
  markdown: string,
  mode: KunDirectiveOptions['mode'] = 'render'
) => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkKunDirectives, { mode })
  return processor.runSync(processor.parse(markdown), markdown) as TreeNode
}

// 把树压成一行便于断言: 段落显示其文字, 其余节点显示类型
const outline = (node: TreeNode): string => {
  if (node.type === 'text') {
    return JSON.stringify(node.value)
  }
  const children = (node.children ?? []).map(outline).join(', ')
  return node.type === 'root' ? children : `${node.type}(${children})`
}

const typesOf = (node: TreeNode): string[] => [
  node.type,
  ...(node.children ?? []).flatMap(typesOf)
]

describe('行内的冒号不是指令', () => {
  it.each([
    '发售时间 10:30 开始',
    '注:这个补丁很好',
    'Re:Zero 是一部作品',
    '主角 CV:花澤香菜',
    '比例 16:9{.wide} 屏幕',
    'magnet:?xt=urn:btih:5d3fab0c1e',
    '前文 :kun-link{href="https://a.example" text="t"} 后文',
    '前文 ::kun-video{src="https://a.example/v.mp4"} 后文'
  ])('%s 原样保留为文字', (markdown) => {
    expect(outline(transform(markdown))).toBe(
      `paragraph(${JSON.stringify(markdown)})`
    )
  })

  // 标签与属性不再被指令吃掉, 里面的行内语法照常解析
  it('冒号后的方括号按普通的行内语法解析', () => {
    expect(outline(transform('a:b[**c**] d'))).toBe(
      'paragraph("a:b[", strong("c"), "] d")'
    )
    expect(typesOf(transform('Re:Zero[1](https://x.example/a)'))).toContain(
      'link'
    )
  })
})

describe('已注册的整行指令', () => {
  it('render: 保留节点并带上校验过的属性', () => {
    const tree = transform(
      '::kun-video{src="https://a.example/v.mp4"}\n\n::kun-link{href="https://a.example" text="正版"}'
    )
    const [video, link] = tree.children ?? []

    expect(readKunDirective(video, 'kun-video')).toEqual({
      src: 'https://a.example/v.mp4'
    })
    expect(readKunDirective(link, 'kun-link')).toEqual({
      href: 'https://a.example',
      text: '正版'
    })
    // 标记按名字区分, 不会被另一个短代码的渲染器认领
    expect(readKunDirective(video, 'kun-link')).toBeNull()
    expect(readKunDirective(link, 'kun-video')).toBeNull()
  })

  it('属性取校验函数归一化后的值, 多余的属性不带过去', () => {
    const [video] =
      transform(
        '::kun-video{src=" HTTPS://a.example/v.mp4 " onclick="alert(1)" class="evil"}'
      ).children ?? []

    expect(readKunDirective(video, 'kun-video')).toEqual({
      src: 'https://a.example/v.mp4'
    })
  })

  it('drop: 已注册的指令不显示, 前后内容不受影响', () => {
    expect(
      outline(
        transform(
          '前言\n\n::kun-video{src="https://a.example/v.mp4"}\n\n后记',
          'drop'
        )
      )
    ).toBe('paragraph("前言"), paragraph("后记")')
  })

  it('没有被标记的节点读不出属性', () => {
    const [paragraph] = transform('普通段落').children ?? []

    expect(readKunDirective(paragraph, 'kun-video')).toBeNull()
    expect(
      readKunDirective({ type: 'leafDirective', data: {} } as Node, 'kun-video')
    ).toBeNull()
  })
})

describe('地址没填的已注册短代码', () => {
  // 投稿模板会留下没填地址的短代码。它不是用户想展示的文字, 发布时不显示;
  // 编辑器里保留成节点, 保存时原样写回
  const BLANK = [
    '::kun-link{href="" text="点我前往购买"}',
    '::kun-link{text="点我前往购买"}',
    '::kun-link{href="  " text="点我前往购买"}',
    '::kun-video{src=""}',
    '::kun-video'
  ]

  it.each(BLANK)('render / drop: %s 不显示', (markdown) => {
    expect(outline(transform(`前言\n\n${markdown}\n\n后记`, 'render'))).toBe(
      'paragraph("前言"), paragraph("后记")'
    )
    expect(outline(transform(`前言\n\n${markdown}\n\n后记`, 'drop'))).toBe(
      'paragraph("前言"), paragraph("后记")'
    )
  })

  it('edit: 保留成节点, 属性是没填的样子', () => {
    const [link, video] =
      transform(`${BLANK[0]}\n\n${BLANK[3]}`, 'edit').children ?? []

    expect(readKunDirective(link, 'kun-link')).toEqual({
      href: '',
      text: '点我前往购买'
    })
    expect(readKunDirective(video, 'kun-video')).toEqual({ src: '' })
  })

  it('edit: 合格的照常保留, 填了却不合格的仍按原文', () => {
    const tree = transform(
      '::kun-video{src="https://a.example/v.mp4"}\n\n::kun-video{src="javascript:alert(1)"}',
      'edit'
    )

    expect(readKunDirective(tree.children?.[0] as Node, 'kun-video')).toEqual({
      src: 'https://a.example/v.mp4'
    })
    expect(outline(tree.children?.[1] as TreeNode)).toBe(
      'paragraph("::kun-video{src=\\"javascript:alert(1)\\"}")'
    )
  })
})

describe.each(['render', 'drop', 'edit'] as const)(
  '未注册或不合格的指令按原文显示 (%s)',
  (mode) => {
    it.each([
      ['未注册的名字', '::foo{bar=1}'],
      ['带标签: 标签里的语法不再解析', '::foo[标签 **粗体**]{bar=1}'],
      ['名字大小写不符', '::KUN-VIDEO{src="https://a.example/v.mp4"}'],
      ['危险协议', '::kun-link{href="javascript:alert(1)" text="x"}'],
      ['媒体地址不许用链接协议', '::kun-video{src="magnet:?xt=urn:btih:abc"}'],
      ['有地址却没有文字', '::kun-link{href="https://a.example/x y"}'],
      // 指令名来自用户输入, 不能命中对象原型上的属性
      ['原型上的名字 constructor', '::constructor{src="https://a.example"}'],
      ['原型上的名字 toString', '::toString']
    ])('%s', (_name, markdown) => {
      expect(outline(transform(markdown, mode))).toBe(
        `paragraph(${JSON.stringify(markdown)})`
      )
    })

    it('引用与列表里的指令同样还原', () => {
      expect(outline(transform('> ::foo{bar=1}', mode))).toBe(
        'blockquote(paragraph("::foo{bar=1}"))'
      )
      expect(outline(transform('- ::foo{bar=1}', mode))).toBe(
        'list(listItem(paragraph("::foo{bar=1}")))'
      )
    })
  }
)

// 没有任何短代码是容器形态。容器语法不解析, 嵌套的容器也就无从拖慢解析 ——
// 旧管线里 2000 层 `:::名字` 要解析 5 秒, 全靠一个预先数行的熔断挡着
describe('容器写法不是语法', () => {
  it.each([
    [':::note\n内容\n:::', 'paragraph(":::note\\n内容\\n:::")'],
    [
      ':::kun-video{src="https://a.example/v.mp4"}\n内容\n:::',
      'paragraph(":::kun-video{src=\\"https://a.example/v.mp4\\"}\\n内容\\n:::")'
    ],
    ['::::outer\n:::inner\n::::', 'paragraph("::::outer\\n:::inner\\n::::")'],
    ['> :::note\n> 内容', 'blockquote(paragraph(":::note\\n内容"))']
  ])('%j 是一段普通文字', (markdown, expected) => {
    expect(outline(transform(markdown))).toBe(expected)
  })

  it('名字以数字、汉字开头的容器同样不解析', () => {
    for (const name of ['1', '注', 'ａ']) {
      const tree = transform(`:::${name}\n`.repeat(2000))

      expect(typesOf(tree)).toEqual(['root', 'paragraph', 'text'])
    }
  })

  it('夹在容器写法之间的整行短代码照常生效', () => {
    expect(
      typesOf(
        transform(
          ':::note\n\n::kun-video{src="https://a.example/v.mp4"}\n\n:::'
        )
      )
    ).toEqual([
      'root',
      'paragraph',
      'text',
      'leafDirective',
      'paragraph',
      'text'
    ])
  })
})

describe('还原出的文字与解析出的文字同等对待', () => {
  // GFM 在建树之后把裸网址变成链接。还原的文字不补这一遍的话, 同一行在编辑器里
  // 保存一次之后再解析, 网址就会从文字变成链接, 发布结果随之改变
  it('还原的那一行里的裸网址同样成为链接', () => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkKunDirectives, { mode: 'render' })
    const markdown = '::kun-link{href="https://a.example/x"}'

    expect(
      outline(processor.runSync(processor.parse(markdown), markdown))
    ).toBe(
      'paragraph("::kun-link{href=\\"", link("https://a.example/x"), "\\"}")'
    )
  })
})

describe('切片与解析器对齐', () => {
  // 解析器跳过文档开头的 BOM, 节点位置按去掉它之后算: 不对齐的话还原出来的那一行
  // 会多出 BOM、少掉最后一个字符
  it('文档开头有 BOM 时还原的原文不错位', () => {
    expect(outline(transform('\uFEFF::foo{bar=1}'))).toBe(
      'paragraph("::foo{bar=1}")'
    )
  })

  it('CRLF 换行的文档照常还原', () => {
    expect(outline(transform('前言\r\n\r\n::foo{bar=1}\r\n\r\n后记'))).toBe(
      'paragraph("前言"), paragraph("::foo{bar=1}"), paragraph("后记")'
    )
  })
})

describe('代码里的指令写法不解析', () => {
  it('围栏代码与缩进代码原样保留', () => {
    expect(
      typesOf(
        transform(
          '```\n::kun-video{src="https://a.example/v.mp4"}\n```\n\n    ::foo'
        )
      )
    ).toEqual(['root', 'code', 'code'])
  })
})

describe('原文缺失', () => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkKunDirectives, { mode: 'render' })

  it('要还原指令却没拿到原文时报错, 不悄悄丢字', () => {
    expect(() => processor.runSync(processor.parse('::foo{bar=1}'))).toThrow(
      'remarkKunDirectives 需要原文'
    )
  })

  it('没有要还原的指令时不需要原文; 空文档同样放行', () => {
    expect(() =>
      processor.runSync(
        processor.parse('::kun-video{src="https://a.example/v.mp4"}')
      )
    ).not.toThrow()
    expect(() => processor.runSync(processor.parse(''), '')).not.toThrow()
  })
})

describe('属性校验', () => {
  it('视频地址只收 http / https 与相对地址', () => {
    expect(parseKunVideoAttrs({ src: 'https://a.example/v.mp4' })).toEqual({
      src: 'https://a.example/v.mp4'
    })
    expect(parseKunVideoAttrs({ src: '/local/v.mp4' })).toEqual({
      src: '/local/v.mp4'
    })
    expect(parseKunVideoAttrs({ src: 'javascript:alert(1)' })).toBeNull()
    expect(parseKunVideoAttrs({ src: 'data:text/html,x' })).toBeNull()
    expect(parseKunVideoAttrs({ src: 'magnet:?xt=urn:btih:abc' })).toBeNull()
    expect(parseKunVideoAttrs({ src: '' })).toBeNull()
    expect(parseKunVideoAttrs({ src: null })).toBeNull()
    expect(parseKunVideoAttrs({})).toBeNull()
  })

  it('链接要有安全的地址和非空的文字', () => {
    expect(
      parseKunLinkAttrs({ href: 'magnet:?xt=urn:btih:abc', text: '磁力' })
    ).toEqual({ href: 'magnet:?xt=urn:btih:abc', text: '磁力' })
    expect(
      parseKunLinkAttrs({ href: 'javascript:alert(1)', text: 'x' })
    ).toBeNull()
    expect(parseKunLinkAttrs({ href: 'https://a.example' })).toBeNull()
    expect(
      parseKunLinkAttrs({ href: 'https://a.example', text: '' })
    ).toBeNull()
    expect(parseKunLinkAttrs({ text: 'x' })).toBeNull()
  })
})
