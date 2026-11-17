import { describe, expect, it } from 'vitest'
import {
  MARKDOWN_MAX_LINE_CONTAINER_MARKERS,
  MARKDOWN_MAX_PARAGRAPH_BRACKETS,
  exceedsCostFuse,
  measureMarkdownCost,
  measureTreeDepth,
  treeDepthExceeds
} from '~/app/api/utils/render/markdownBudget'

const markers = (markdown: string) =>
  measureMarkdownCost(markdown).maxLineContainerMarkers
const brackets = (markdown: string) =>
  measureMarkdownCost(markdown).maxParagraphBrackets

describe('measureMarkdownCost: 单行容器标记', () => {
  // P02-01 的四类输入: 10007 字符以内就能让解析栈溢出或耗时数秒
  it.each([
    ['引用', `${'>'.repeat(2500)}x`, 2500],
    ['无序列表', `${'- '.repeat(5003)}x`, 5003],
    ['有序列表', `${'1. '.repeat(3335)}x`, 3335],
    ['引用与列表交替', `${'> - '.repeat(2500)}x`, 5000]
  ])('数出同一行里嵌套的%s', (_name, markdown, expected) => {
    expect(markers(markdown)).toBe(expected)
  })

  it('取各行中的最大值', () => {
    expect(markers('> a\n> > > b\n- c')).toBe(3)
  })

  // 余下整段只由同一个 - * _ 与空白组成且不少于 3 个: 那是分隔线, 不是嵌套列表
  it.each([
    ['- - - - - - - - - -', 0],
    ['* * *', 0],
    ['*\t*\t*', 0],
    ['_ _ _', 0],
    ['- - -\r', 0],
    ['> - - -', 1],
    ['* - - -', 1],
    ['- -', 2],
    ['- - - x', 3],
    ['- * - *', 4]
  ])('分隔线不算列表标记: %j', (markdown, expected) => {
    expect(markers(markdown)).toBe(expected)
  })

  it.each([
    ['姓名：____在这里填____'],
    ['(＾▽＾)~ ~(￣▽￣)~*  ＿(:з」∠)＿'],
    ['-没有空格不是列表'],
    ['*强调* 与 **加粗**'],
    ['12345678901. 超过 9 位数字不是有序列表'],
    ['| - | - |'],
    ['----------']
  ])('正常文字不误报: %j', (markdown) => {
    expect(markers(markdown)).toBe(0)
  })

  it('+ 与带括号的序号同样是列表标记', () => {
    expect(markers('+ a')).toBe(1)
    expect(markers('1) 2) x')).toBe(2)
    expect(markers('2026. 11. 14. x')).toBe(3)
  })

  // 扫描器只可能多数、不能少数。下面每一种都是「扫描器以为这些行不用数、解析器却
  // 照常解析成容器」的写法, 少数一行熔断就被绕过, 解析要同步阻塞 2~6 秒
  it.each([
    // 一行是不是围栏取决于所在的容器与 HTML 块: 列表里的围栏随列表结束而关闭,
    // HTML 注释与 HTML 块里的 ``` 根本不是围栏, ` 围栏的说明串里不能再有 `
    ['列表里的围栏', '- a\n  ```\n'],
    ['同一行的列表与围栏', '- ```\n'],
    ['HTML 注释里的围栏', '<!--\n```\n-->\n'],
    ['HTML 块里的围栏', '<div>\n```\n\n'],
    ['说明串带反引号的围栏', '``` `\n'],
    // 行结束符与解析器一致: 孤立的 \r 也结束一行
    ['孤立 CR 之后', 'x\r'],
    ['CRLF 之后', 'x\r\n'],
    // 解析器会剥掉文档开头的 BOM
    ['文档开头的 BOM 之后', '\uFEFF']
  ])('%s的行照数不误', (_name, prefix) => {
    expect(markers(`${prefix}${'- '.repeat(5000)}x`)).toBe(5000)
    expect(markers(`${prefix}${'>'.repeat(2500)}x`)).toBe(2500)
  })

  // 因此真正的围栏代码里的行也会被数进去: 熔断不承担正确性, 代价只是行首带 257 个
  // 以上容器标记的代码行会被误判, 真实内容里不存在这样的行
  it('围栏代码内的行同样计入', () => {
    expect(markers(`\`\`\`\n${'> '.repeat(300)}\n\`\`\``)).toBe(300)
  })

  // 对每个标记都判一次「余下是不是分隔线」会退化成 O(n²): 百万级标记要在默认超时内
  // 扫完。最坏形状是行尾有一长串分隔线字符、前面的标记却不在其中
  it('扫描耗时与长度成线性', () => {
    expect(markers(`${'- '.repeat(500_000)}x`)).toBe(500_000)
    expect(markers('> '.repeat(500_000))).toBe(500_000)
    expect(markers('- '.repeat(500_000))).toBe(0)
    expect(markers(`${'- '.repeat(250_000)}x ${'- '.repeat(250_000)}`)).toBe(
      250_000
    )
  })
})

describe('measureMarkdownCost: 同段方括号个数', () => {
  // 这些输入的树都只有两三层 (结构上限看不到), 解析却要 0.5~1 秒
  it.each([
    ['嵌套图片', `${'!['.repeat(1666)}x${'](u)'.repeat(1666)}`, 1666],
    ['嵌套链接', `${'['.repeat(1666)}x${'](u)'.repeat(1666)}`, 1666],
    [
      '每行一个开括号, 末尾全闭',
      `${'[\n'.repeat(3300)}x${']'.repeat(3300)}`,
      3300
    ],
    // 一个开括号都没有: 每个 ] 仍要在本段里回找一遍
    ['只有闭括号', 'a]'.repeat(5003), 5003]
  ])('数出一段里的%s', (_name, markdown, expected) => {
    expect(brackets(markdown)).toBe(expected)
  })

  // 行内代码、HTML 标签、自动链接里的 ] 解析器不当闭合: 遇 ] 就减一的深度计数会被
  // 它们压在 1, 而解析器照样嵌出上千层图片
  it.each([
    ['行内代码', '![`]`'],
    ['HTML 标签', '![<a b="]">'],
    ['自动链接', '![<http://a/]>']
  ])('藏在%s里的假闭合压不低读数', (_name, unit) => {
    expect(brackets(`${unit.repeat(900)}x${'](u)'.repeat(900)}`)).toBe(1800)
  })

  it('行内内容不跨空行: 按空行分段, 取各段的最大值', () => {
    expect(brackets('[a] [b]\n[c]\n\n[d]')).toBe(3)
    expect(brackets(`${'[x]\n\n'.repeat(5000)}`)).toBe(1)
    // 只有空白的行也是空行; 只有 > 的行不是 (多数无妨)
    expect(brackets('[a]\n \t\n[b]')).toBe(1)
    expect(brackets('> [a]\n>\n> [b]')).toBe(2)
  })

  it('孤立 CR 分隔的行属于同一段, 逐行累计', () => {
    expect(brackets(`${'[\r'.repeat(3000)}`)).toBe(3000)
  })

  it.each([
    ['[2026-11-17 12:00:00] [INFO] [patch] 启动完成\n'.repeat(120), 360],
    ['[00:12.34]这一句歌词\n'.repeat(300), 300],
    ['[链接](https://a.example) '.repeat(200), 200]
  ])('日志、歌词、链接列表离上限很远: %#', (markdown, expected) => {
    expect(brackets(markdown)).toBe(expected)
    expect(exceedsCostFuse(markdown)).toBe(false)
  })
})

describe('exceedsCostFuse', () => {
  it('同段方括号超过上限才熔断', () => {
    const atLimit = ']'.repeat(MARKDOWN_MAX_PARAGRAPH_BRACKETS)
    expect(exceedsCostFuse(atLimit)).toBe(false)
    expect(exceedsCostFuse(`${atLimit}]`)).toBe(true)
    expect(exceedsCostFuse(`${atLimit}\n\n${atLimit}`)).toBe(false)
  })

  it('单行容器标记超过上限才熔断', () => {
    const atLimit = `${'- '.repeat(MARKDOWN_MAX_LINE_CONTAINER_MARKERS)}x`
    expect(exceedsCostFuse(atLimit)).toBe(false)
    expect(exceedsCostFuse(`- ${atLimit}`)).toBe(true)
  })
})

describe('measureTreeDepth', () => {
  it('根节点深度为 0, 取最深的叶子', () => {
    expect(measureTreeDepth({})).toBe(0)
    expect(
      measureTreeDepth({
        children: [{ children: [{}] }, { children: [{ children: [{}] }] }]
      })
    ).toBe(3)
  })

  // 被测的树可能正是深到让递归遍历栈溢出的那种
  it('十万层的树不会让它自己栈溢出', () => {
    const root: { children?: unknown[] } = {}
    let cursor = root
    for (let depth = 0; depth < 100_000; depth++) {
      const child: { children?: unknown[] } = {}
      cursor.children = [child]
      cursor = child
    }

    expect(measureTreeDepth(root)).toBe(100_000)
    expect(treeDepthExceeds(root, 99_999)).toBe(true)
    expect(treeDepthExceeds(root, 100_000)).toBe(false)
  })
})
