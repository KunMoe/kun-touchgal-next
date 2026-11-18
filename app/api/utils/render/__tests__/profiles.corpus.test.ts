import { describe, expect, it } from 'vitest'
import { renderKunMarkdown } from '~/app/api/utils/render/renderKunMarkdown'
import { findInvariantViolations } from './fixtures/htmlInvariants'
import { kunMarkdownCorpus } from './fixtures/markdownCorpus'
import type { KunMarkdownProfile } from '~/app/api/utils/render/renderKunMarkdown'
import type {
  KunCorpusEntry,
  KunCorpusExpectation
} from './fixtures/markdownCorpus'

// 渲染输出的回归基线: 每条语料在每个 profile 下的输出, 以及净化不变量。
// 净化的位置与白名单就是 XSS 边界, 这里是它唯一的输出级测试

const PROFILES: KunMarkdownProfile[] = ['comment', 'note', 'introduction']

const expectationFor = (
  entry: KunCorpusEntry,
  profile: KunMarkdownProfile
): KunCorpusExpectation =>
  typeof entry.html === 'object' && 'comment' in entry.html
    ? entry.html[profile]
    : entry.html

const render = async (profile: KunMarkdownProfile, markdown: string) =>
  renderKunMarkdown(profile, markdown, { cache: false })

describe('语料本身', () => {
  it('id 不重复', () => {
    const ids = kunMarkdownCorpus.map((entry) => entry.id)

    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe.each(PROFILES)('%s profile 的语料输出', (profile) => {
  it.each(kunMarkdownCorpus.map((entry) => [entry.id, entry] as const))(
    '%s',
    async (_id, entry) => {
      const result = await render(profile, entry.markdown)

      expect(result.ok).toBe(true)

      const expected = expectationFor(entry, profile)
      if (typeof expected === 'string') {
        expect(result.html).toBe(expected)
      } else {
        for (const part of expected.includes) {
          expect(result.html).toContain(part)
        }
        for (const part of expected.excludes ?? []) {
          expect(result.html).not.toContain(part)
        }
      }

      expect(findInvariantViolations(result.html)).toEqual(
        entry.knownBad?.violates ?? []
      )

      const want = entry.knownBad?.want?.[profile]
      if (want !== undefined) {
        expect(
          result.html,
          '输出已经是 knownBad.want: 把这条语料的 html 换成它, 并删掉 knownBad'
        ).not.toBe(want)
      }
    }
  )
})

// 反空转: 检测器认不出违规的话, 上面的不变量断言恒真
describe('净化不变量检测器', () => {
  it.each([
    ['<script>alert(1)</script>', ['forbidden-element']],
    ['<iframe src="https://a.example"></iframe>', ['forbidden-element']],
    [
      '<svg><set attributeName="href" to="javascript:alert(1)"></set></svg>',
      ['forbidden-element']
    ],
    [
      '<svg><animate values="javascript:alert(1)"></animate></svg>',
      ['forbidden-element']
    ],
    ['<p onclick="alert(1)">a</p>', ['event-handler']],
    ['<svg ONLOAD="alert(1)"></svg>', ['event-handler']],
    ['<p style="position:fixed">a</p>', ['inline-style']],
    ['<a href="javascript:alert(1)">a</a>', ['unsafe-url']],
    ['<a href="JaVaScRiPt:alert(1)">a</a>', ['unsafe-url']],
    ['<a href=" &#x6A;avascript:alert(1)">a</a>', ['unsafe-url']],
    ['<a href="java&#x9;script:alert(1)">a</a>', ['unsafe-url']],
    ['<a data-href="vbscript:msgbox(1)">a</a>', ['unsafe-url']],
    ['<img src="data:image/svg+xml,x">', ['unsafe-url']],
    // 媒体地址的协议范围比链接窄
    ['<img src="magnet:?xt=urn:btih:abc">', ['unsafe-url']],
    ['<div data-src="javascript:alert(1)"></div>', ['unsafe-url']],
    [
      '<form action="https://a.example"></form>',
      ['forbidden-element', 'unsafe-url']
    ],
    ['<img id="body" src="/a.png">', ['dom-clobbering']],
    [
      '<li id="user-content-fn-1">a</li><li id="user-content-fn-1">b</li>',
      ['duplicate-id']
    ],
    ['<img name="getElementById" src="/a.png">', ['dom-clobbering']],
    ['<a href="#user-content-fn-9">a</a>', ['fragment-target']],
    [
      '<p onclick="x" style="y"><a href="javascript:z">a</a></p>',
      ['event-handler', 'inline-style', 'unsafe-url']
    ]
  ])('认得出 %s', (html, violations) => {
    expect(findInvariantViolations(html)).toEqual(violations)
  })

  it.each([
    '<p>文字 &#x3C;script> javascript:alert(1) onclick=</p>',
    '<a href="https://a.example/x" data-href="magnet:?xt=urn:btih:abc">a</a>',
    '<a href="/doc?a=b:c">a</a><a href="//a.example/x">b</a>',
    '<a href="#user-content-fn-1">a</a><li id="user-content-fn-1">b</li>',
    // 用户手写的页内链接指向哪里都行
    '<a href="#download">a</a>',
    '<a href="#user-content-%E6%A0%87%E9%A2%98">a</a><h1 id="user-content-标题">b</h1>',
    // 引号里长得像属性的文字不是属性
    '<img src="https://a.example/a.png" alt="a&#x22; onerror=&#x22;alert(1)">',
    '<img alt="<script> style=x" src="/a.png"><input disabled type="checkbox">'
  ])('不误报 %s', (html) => {
    expect(findInvariantViolations(html)).toEqual([])
  })

  it('读不懂的标签形状直接报错, 不当作通过', () => {
    expect(() => findInvariantViolations("<p title='a'>x</p>")).toThrow(
      '无法解析的标签'
    )
    expect(() => findInvariantViolations('<p title=a>x</p>')).toThrow(
      '无法解析的标签'
    )
    expect(() => findInvariantViolations('<!-- x -->')).toThrow(
      '无法解析的标签'
    )
  })
})
