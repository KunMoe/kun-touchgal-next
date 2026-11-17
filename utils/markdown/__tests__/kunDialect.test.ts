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

    it('注册为整行的名字写成容器, 同样按原文', () => {
      expect(
        outline(
          transform(
            ':::kun-video{src="https://a.example/v.mp4"}\n内容\n:::',
            mode
          )
        )
      ).toBe(
        'paragraph(":::kun-video{src=\\"https://a.example/v.mp4\\"}"), paragraph("内容"), paragraph(":::")'
      )
    })

    it('容器还原开、闭两行, 里面的内容照常解析', () => {
      expect(outline(transform(':::note\n**内容**\n:::', mode))).toBe(
        'paragraph(":::note"), paragraph(strong("内容")), paragraph(":::")'
      )
    })

    it('容器的标签只出现在开栅栏那一行, 不重复成一段', () => {
      expect(outline(transform(':::note[标题]\n内容\n:::', mode))).toBe(
        'paragraph(":::note[标题]"), paragraph("内容"), paragraph(":::")'
      )
    })

    it('没有收尾的容器只还原开栅栏', () => {
      expect(outline(transform(':::spoiler\n剧透内容', mode))).toBe(
        'paragraph(":::spoiler"), paragraph("剧透内容")'
      )
    })

    it('比开栅栏短的冒号行是内容, 不是收尾', () => {
      expect(outline(transform('::::outer\n内容\n\n:::', mode))).toBe(
        'paragraph("::::outer"), paragraph("内容"), paragraph(":::")'
      )
      expect(outline(transform(':::a\n内容\n:::::', mode))).toBe(
        'paragraph(":::a"), paragraph("内容"), paragraph(":::::")'
      )
    })

    it('嵌套的容器逐层还原', () => {
      expect(
        outline(transform('::::outer\n:::inner\n内容\n:::\n::::', mode))
      ).toBe(
        'paragraph("::::outer"), paragraph(":::inner"), paragraph("内容"), paragraph(":::"), paragraph("::::")'
      )
    })

    it('引用与列表里的指令同样还原, 收尾行不带引用前缀', () => {
      expect(outline(transform('> :::note\n> 内容\n> :::', mode))).toBe(
        'blockquote(paragraph(":::note"), paragraph("内容"), paragraph(":::"))'
      )
      expect(outline(transform('- ::foo{bar=1}', mode))).toBe(
        'list(listItem(paragraph("::foo{bar=1}")))'
      )
    })

    it('容器里的已注册指令仍按模式处理', () => {
      expect(
        typesOf(
          transform(
            ':::note\n::kun-video{src="https://a.example/v.mp4"}\n:::',
            mode
          )
        )
      ).toEqual(
        mode === 'drop'
          ? ['root', 'paragraph', 'text', 'paragraph', 'text']
          : ['root', 'paragraph', 'text', 'leafDirective', 'paragraph', 'text']
      )
    })
  }
)

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
