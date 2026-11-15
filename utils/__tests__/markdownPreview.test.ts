import { describe, expect, it } from 'vitest'
import { markdownToPreviewHtml } from '~/utils/markdownPreview'

const XSS_PAYLOAD = '<img src=x onerror=alert(1)>'

// escapeHtml 已转掉用户文本里的 ", 所以输出中每个 " 都是我们生成的属性分隔符,
// 奇数段即属性值。属性值里出现裸 < 或 > 就说明用户文本截断了属性
const hasAttributeBreakout = (html: string) =>
  html
    .split('"')
    .some((segment, index) => index % 2 === 1 && /[<>]/.test(segment))

describe('markdownToPreviewHtml', () => {
  it('所有行内上下文的原始 HTML 均被转义', () => {
    const cases = [
      `hello ${XSS_PAYLOAD} world`,
      `# ${XSS_PAYLOAD}`,
      `###### ${XSS_PAYLOAD}`,
      `- ${XSS_PAYLOAD}`,
      `1. ${XSS_PAYLOAD}`,
      `> ${XSS_PAYLOAD}`,
      `|${XSS_PAYLOAD}|\n|---|`,
      `**bold** <script>alert(1)</script>`
    ]

    for (const markdown of cases) {
      const html = markdownToPreviewHtml(markdown)
      expect(html).not.toMatch(/<(?:img|script|svg)\b/)
      expect(html).toContain('&lt;')
    }
  })

  it('图片与链接的属性值不可被闭合逃逸', () => {
    const cases = [
      // 用户自带引号
      '![a](x" onerror="alert(1))',
      '[a](x" onmouseover="alert(1))',
      // 借前一条规则生成的引号截断属性: 链接语法藏在图片 src 里
      '![a](q[w](x onerror=location=name )X)',
      '![a](q[w](x onerror=location=name)X)',
      '![a](q[w](x onerror=location=name )![b](c[d](e onerror=location=name )f)',
      // 同源的良性表现: 后续规则匹配到生成标签内部
      '[a](x*y)*z*',
      '[a](x`y)`z`',
      // 实体解码产出的特殊字符必须仍被 escapeHtml 拦下
      '![a](x&quot;y)',
      '[a](x&quot; onmouseover=&quot;alert&#40;1&#41;)',
      '![a](x&#60;img src=y onerror=alert&#40;1&#41;&#62;)',
      '![a](x&#34; onerror=&#34;alert&#40;1&#41;)'
    ]

    for (const markdown of cases) {
      expect(hasAttributeBreakout(markdownToPreviewHtml(markdown))).toBe(false)
    }

    // 反空转: 检测器必须能认出被截断的属性, 否则上面的断言恒真
    expect(
      hasAttributeBreakout('<img src="q<a href="x onerror=alert" alt="a" />')
    ).toBe(true)
  })

  // 预览与发布端用同一组协议白名单; 实体写法在解码之后才判定
  it('不安全协议的链接只保留文字, 图片只保留替代文字', () => {
    const cases = [
      '[点我](javascript:alert(document.cookie))',
      '[点我](JaVaScRiPt:location=name)',
      '[点我](&#106;avascript:location=name)',
      '[点我](&#x6A;avascript&colon;location=name)',
      '[点我](  javascript:location=name)',
      '[点我](vbscript:msgbox)',
      '[点我](data:text/html,x)',
      '![点我](javascript:location=name)',
      '![点我](data:image/svg+xml,x)'
    ]

    for (const markdown of cases) {
      const html = markdownToPreviewHtml(markdown)

      expect(html, markdown).not.toMatch(/<a\b|<img\b/)
      expect(html, markdown).not.toMatch(/(href|src)=/)
      expect(html, markdown).toContain('点我')
    }
  })

  it('白名单协议与相对地址照常输出, 协议名统一成小写', () => {
    expect(markdownToPreviewHtml('[站点](HTTPS://example.com/a?b=1&c=2)')).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">站点</a></p>'
    )
    expect(markdownToPreviewHtml('[磁力](magnet:?xt=urn:btih:abc)')).toContain(
      'href="magnet:?xt=urn:btih:abc"'
    )
    expect(markdownToPreviewHtml('[相对](/doc/notice)')).toContain(
      'href="/doc/notice"'
    )
    expect(markdownToPreviewHtml('![图](https://img.example/a.png)')).toContain(
      '<img src="https://img.example/a.png" alt="图"'
    )
    // 图片只放行 http / https, 链接可用的其它协议对图片无效
    expect(markdownToPreviewHtml('![图](magnet:?xt=urn:btih:abc)')).toBe(
      '<p>图</p>'
    )
  })

  it('代码块内容仍被转义', () => {
    expect(markdownToPreviewHtml(`\`\`\`\n${XSS_PAYLOAD}\n\`\`\``)).toBe(
      '<pre><code>&lt;img src=x onerror=alert(1)&gt;</code></pre>'
    )
  })

  it('常规 markdown 渲染不回归', () => {
    expect(markdownToPreviewHtml('**a & b**')).toBe(
      '<p><strong>a &amp; b</strong></p>'
    )
    expect(markdownToPreviewHtml('`<div>`')).toBe(
      '<p><code>&lt;div&gt;</code></p>'
    )
    expect(markdownToPreviewHtml('[link](https://kungal.com?a=1&b=2)')).toBe(
      '<p><a href="https://kungal.com?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">link</a></p>'
    )
    expect(markdownToPreviewHtml('~~del~~ *em* ***both***')).toBe(
      '<p><del>del</del> <em>em</em> <strong><em>both</em></strong></p>'
    )
    expect(markdownToPreviewHtml('`*a*`')).toBe('<p><code>*a*</code></p>')
  })

  it('嵌套行内语法不再被转义成字面文本', () => {
    expect(markdownToPreviewHtml('*[a](https://kungal.com)*')).toBe(
      '<p><em><a href="https://kungal.com" target="_blank" rel="noopener noreferrer">a</a></em></p>'
    )
    expect(markdownToPreviewHtml('[a *b* `c`](https://kungal.com)')).toBe(
      '<p><a href="https://kungal.com" target="_blank" rel="noopener noreferrer">a <em>b</em> <code>c</code></a></p>'
    )
  })

  it('多列表格渲染为完整闭合的 table 结构', () => {
    expect(markdownToPreviewHtml('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>\n' +
        '<tr><td>1</td><td>2</td></tr>\n' +
        '</tbody></table>'
    )
  })

  it('空单元格保留为空 td 而非丢弃', () => {
    expect(markdownToPreviewHtml('| a | b |\n|---|---|\n|  | 2 |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>\n' +
        '<tr><td></td><td>2</td></tr>\n' +
        '</tbody></table>'
    )
  })

  it('行末多敲 | 产生的空 cell 按表头列数裁断', () => {
    expect(markdownToPreviewHtml('| a | b |\n|---|---|\n| 1 | 2 ||')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>\n' +
        '<tr><td>1</td><td>2</td></tr>\n' +
        '</tbody></table>'
    )
  })

  it('body 行非空 cell 多于表头时同样裁断', () => {
    expect(markdownToPreviewHtml('| a | b |\n|---|---|\n| 1 | 2 | 3 |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>\n' +
        '<tr><td>1</td><td>2</td></tr>\n' +
        '</tbody></table>'
    )
  })

  it('body 行 cell 少于表头时补空 td', () => {
    expect(markdownToPreviewHtml('| a | b |\n|---|---|\n| 1 |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>\n' +
        '<tr><td>1</td><td></td></tr>\n' +
        '</tbody></table>'
    )
  })

  it('cell 内 \\| 转义管道不分隔且解码为 |', () => {
    // 修复前: 裸 split 把 a\|b 劈成两 cell, 钳制把末列 c 静默裁掉
    expect(markdownToPreviewHtml('| a | b |\n|---|---|\n| a\\|b | c |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>\n' +
        '<tr><td>a|b</td><td>c</td></tr>\n' +
        '</tbody></table>'
    )
  })

  it('表头 cell 内 \\| 不放大列数', () => {
    // 修复前: 表头被劈成 3 列, 所有 body 行都被补一空列
    expect(markdownToPreviewHtml('| a\\|b | c |\n|---|---|\n| 1 | 2 |')).toBe(
      '<table><thead><tr><th>a|b</th><th>c</th></tr></thead><tbody>\n' +
        '<tr><td>1</td><td>2</td></tr>\n' +
        '</tbody></table>'
    )
  })

  it('转义反斜杠 \\\\ 后的 | 仍是分隔符', () => {
    // \\ 是转义反斜杠, 其后的 | 分隔; \\ 本身不解码 (预览器整体不做反斜杠转义)
    expect(markdownToPreviewHtml('| a | b |\n|---|---|\n| a\\\\| c |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>\n' +
        '<tr><td>a\\\\</td><td>c</td></tr>\n' +
        '</tbody></table>'
    )
  })

  it('带对齐语法的分隔符可被识别', () => {
    const html = markdownToPreviewHtml('| a | b |\n| :--- | ---: |\n| 1 | 2 |')
    expect(html).toContain('<th>a</th><th>b</th>')
    expect(html).toContain('<tr><td>1</td><td>2</td></tr>')
    expect(html).toMatch(/<\/tbody><\/table>$/)
  })

  it('表格在后续内容前闭合', () => {
    expect(markdownToPreviewHtml('| a |\n| --- |\n| 1 |\n\nafter')).toBe(
      '<table><thead><tr><th>a</th></tr></thead><tbody>\n' +
        '<tr><td>1</td></tr>\n' +
        '</tbody></table>\n' +
        '<p>after</p>'
    )
  })

  it('表格在文档结尾处闭合', () => {
    expect(markdownToPreviewHtml('| a |\n| --- |')).toBe(
      '<table><thead><tr><th>a</th></tr></thead><tbody>\n</tbody></table>'
    )
  })

  it('无分隔符的竖线行仍是字面段落', () => {
    expect(markdownToPreviewHtml('| a |')).toBe('<p>| a |</p>')
  })

  // 期望值取自服务端 unified 管线 (app/api/utils/render/markdownToHtml.ts) 的实测输出,
  // 逐字比对的是浏览器最终显示的文本而非 HTML 字面量
  it('实体引用的解码与发布端一致', () => {
    // AT&amp;T 曾预览显示 AT&amp;T 而发布显示 AT&T
    expect(markdownToPreviewHtml('AT&amp;T')).toBe('<p>AT&amp;T</p>')
    expect(markdownToPreviewHtml('AT&T')).toBe('<p>AT&amp;T</p>')
    expect(markdownToPreviewHtml('&copy; 2026')).toBe('<p>© 2026</p>')
    expect(markdownToPreviewHtml('&nbsp;x')).toBe('<p>\u00A0x</p>')
    expect(markdownToPreviewHtml('&#39;q&#39;')).toBe("<p>'q'</p>")
    expect(markdownToPreviewHtml('&#x1F600;')).toBe('<p>😀</p>')
    expect(markdownToPreviewHtml('&lt;script&gt;')).toBe(
      '<p>&lt;script&gt;</p>'
    )
    expect(markdownToPreviewHtml('[a](x&#41;y)')).toBe(
      '<p><a href="x)y" target="_blank" rel="noopener noreferrer">a</a></p>'
    )
  })

  it('实体不参与结构判定', () => {
    // 服务端输出纯文本 *foo* 而非 <em>, 故解码只能逐片段做, 不能整行预解码
    expect(markdownToPreviewHtml('&#42;foo&#42;')).toBe('<p>*foo*</p>')
    expect(markdownToPreviewHtml('&#96;code&#96;')).toBe('<p>`code`</p>')
    expect(markdownToPreviewHtml('&#35; heading')).toBe('<p># heading</p>')
  })

  it('代码上下文不解码实体', () => {
    // 服务端在代码块与代码 span 内同样不解码, 两侧本就一致
    expect(markdownToPreviewHtml('`&amp;`')).toBe(
      '<p><code>&amp;amp;</code></p>'
    )
    expect(markdownToPreviewHtml('```\n&amp;\n```')).toBe(
      '<pre><code>&amp;amp;</code></pre>'
    )
  })

  it('非法实体保持原样', () => {
    // 反空转: 解码器不能把任意 &...; 都吞掉
    expect(markdownToPreviewHtml('&notreal;')).toBe('<p>&amp;notreal;</p>')
    expect(markdownToPreviewHtml('&notit;')).toBe('<p>&amp;notit;</p>')
    expect(markdownToPreviewHtml('&amp')).toBe('<p>&amp;amp</p>')
    expect(markdownToPreviewHtml('&Amp;')).toBe('<p>&amp;Amp;</p>')
    expect(markdownToPreviewHtml('a & b')).toBe('<p>a &amp; b</p>')
    // 超出 micromark 长度上限: 十进制 7 位、十六进制 6 位
    expect(markdownToPreviewHtml('&#99999999;')).toBe('<p>&amp;#99999999;</p>')
    expect(markdownToPreviewHtml('&#xfff9999;')).toBe('<p>&amp;#xfff9999;</p>')
    // 越界与代理区码点归一为 U+FFFD
    expect(markdownToPreviewHtml('&#0;')).toBe('<p>\uFFFD</p>')
    expect(markdownToPreviewHtml('&#xD800;')).toBe('<p>\uFFFD</p>')
  })
})
