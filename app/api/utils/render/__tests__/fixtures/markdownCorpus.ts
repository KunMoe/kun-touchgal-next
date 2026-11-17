import type { KunMarkdownProfile } from '~/app/api/utils/render/renderKunMarkdown'

// 三个渲染 profile 共用的输出语料。它同时服务三件事:
// - profiles.corpus.test.ts: 逐条断言输出与净化不变量 (XSS 边界的输出级回归);
// - profileLock.test.ts: 同一策略版本下输出不许变, 变了就要递增版本;
// - markdownPreviewParity.test.ts: 编辑器预览与发布结果在纯文字上的一致性。
//
// 加一条语料: 在这里写下 markdown 与期望的输出, 再按 profileLock.test.ts 头注释
// 重新生成锁文件。期望输出要自己读过、确认是对的再写; 明知不对的现状用 knownBad 标出

export type KunCorpusTag =
  | 'xss'
  | 'colon'
  | 'directive'
  | 'gfm'
  | 'frontmatter'
  // 不含任何 markdown 语法的纯文字: 预览与发布结果应当逐字相同
  | 'plain'

export type KunCorpusInvariant =
  | 'forbidden-element'
  | 'event-handler'
  | 'inline-style'
  | 'unsafe-url'
  | 'fragment-target'

// 整段输出, 或 (输出很长时) 必须包含 / 不得包含的片段
export type KunCorpusExpectation =
  string | { includes: readonly string[]; excludes?: readonly string[] }

export interface KunCorpusEntry {
  id: string
  tags: readonly KunCorpusTag[]
  markdown: string
  // 写一个值表示三个 profile 输出相同
  html: KunCorpusExpectation | Record<KunMarkdownProfile, KunCorpusExpectation>
  // html 记的是现状, 而现状是错的或尚无定论
  knownBad?: {
    // 缺陷编号, 或一句话说清哪里不对
    defect: string
    // 修好之后的输出。给了就会被检查: 输出一旦等于它, 测试要求把 html 换成它并删掉 knownBad
    want?: Partial<Record<KunMarkdownProfile, string>>
    // 现状违反的不变量。修好之后不再违反, 测试同样会要求删掉
    violates?: readonly KunCorpusInvariant[]
  }
}

export const kunMarkdownCorpus: readonly KunCorpusEntry[] = [
  // ---- XSS 载荷: 净化边界。危险地址被摘掉属性, 原始 HTML 整段不输出 ----
  {
    id: 'xss-link-javascript',
    tags: ['xss'],
    markdown: '[x](javascript:alert(1))',
    html: '<p><a>x</a></p>'
  },
  {
    id: 'xss-image-javascript',
    tags: ['xss'],
    markdown: '![x](javascript:alert(1))',
    html: '<p><img alt="x" loading="lazy" decoding="async"></p>'
  },
  {
    id: 'xss-link-mixed-case-scheme',
    tags: ['xss'],
    markdown: '[x](JaVaScRiPt:alert(1))',
    html: '<p><a>x</a></p>'
  },
  {
    id: 'xss-link-entity-scheme',
    tags: ['xss'],
    markdown: '[x](&#106;avascript:alert(1))',
    html: '<p><a>x</a></p>'
  },
  {
    id: 'xss-link-tab-in-scheme',
    tags: ['xss'],
    markdown: '[x](java&#9;script:alert(1))',
    html: '<p><a data-kun-external-link="" data-text="x">x</a></p>'
  },
  {
    id: 'xss-link-vbscript',
    tags: ['xss'],
    markdown: '[x](vbscript:msgbox(1))',
    html: '<p><a>x</a></p>'
  },
  {
    id: 'xss-link-data-uri',
    tags: ['xss'],
    markdown: '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    html: '<p><a>x</a></p>'
  },
  {
    id: 'xss-image-data-uri',
    tags: ['xss'],
    markdown: '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
    html: '<p><img alt="x" loading="lazy" decoding="async"></p>'
  },
  {
    id: 'xss-autolink-javascript',
    tags: ['xss'],
    markdown: '<javascript:alert(1)>',
    html: '<p><a>javascript:alert(1)</a></p>'
  },
  {
    id: 'xss-reference-javascript',
    tags: ['xss'],
    markdown: '[x][y]\n\n[y]: javascript:alert(1)',
    html: '<p><a>x</a></p>'
  },
  {
    id: 'xss-link-backslash-host',
    tags: ['xss'],
    markdown: '[c](/\\evil.example.com)',
    html: '<p><a href="/%5Cevil.example.com" data-kun-external-link="" data-href="/%5Cevil.example.com" data-text="c">c</a></p>'
  },
  {
    id: 'xss-link-protocol-relative',
    tags: ['xss'],
    markdown: '[c](//evil.example.com/a)',
    html: '<p><a href="//evil.example.com/a" data-kun-external-link="" data-href="//evil.example.com/a" data-text="c">c</a></p>'
  },
  {
    id: 'xss-link-title-breakout',
    tags: ['xss'],
    markdown: '[x](https://a.example "t\\" onmouseover=\\"alert(1)")',
    html: '<p><a href="https://a.example" data-kun-external-link="" data-href="https://a.example" data-text="x">x</a></p>'
  },
  {
    id: 'xss-image-alt-breakout',
    tags: ['xss'],
    markdown: '![a" onerror="alert(1)](https://a.example/a.png)',
    html: '<p><img src="https://a.example/a.png" alt="a&#x22; onerror=&#x22;alert(1)" loading="lazy" decoding="async"></p>'
  },
  {
    id: 'xss-raw-script',
    tags: ['xss'],
    markdown: '<script>alert(1)</script>',
    html: ''
  },
  {
    id: 'xss-raw-img-onerror',
    tags: ['xss'],
    markdown: '前 <img src=x onerror=alert(1)> 后',
    html: '<p>前  后</p>'
  },
  {
    id: 'xss-raw-iframe',
    tags: ['xss'],
    markdown: '<iframe src="https://evil.example.com"></iframe>',
    html: ''
  },
  {
    id: 'xss-raw-style-and-handler',
    tags: ['xss'],
    markdown:
      '<a href="https://a.example" style="position:fixed" onclick="alert(1)">x</a>',
    html: '<p>x</p>'
  },
  {
    id: 'xss-raw-svg',
    tags: ['xss'],
    markdown:
      '<svg onload="alert(1)"><path d="M0 0" onclick="alert(1)"/></svg>',
    html: '<p></p>'
  },
  {
    id: 'xss-html-comment',
    tags: ['xss'],
    markdown: '<!-- <script>alert(1)</script> -->\n\n正文',
    html: '<p>正文</p>'
  },
  {
    id: 'xss-kun-link-javascript',
    tags: ['xss', 'directive'],
    markdown: '::kun-link{href="javascript:alert(1)" text="x"}',
    html: '<p>::kun-link{href="javascript:alert(1)" text="x"}</p>'
  },
  {
    id: 'xss-kun-video-javascript',
    tags: ['xss', 'directive'],
    markdown: '::kun-video{src="javascript:alert(1)"}',
    html: '<p>::kun-video{src="javascript:alert(1)"}</p>'
  },
  {
    id: 'xss-kun-video-data-uri',
    tags: ['xss', 'directive'],
    markdown: '::kun-video{src="data:text/html,<script>alert(1)</script>"}',
    html: {
      comment:
        '<p>::kun-video{src="data:text/html,&#x3C;script>alert(1)&#x3C;/script>"}</p>',
      note: '<p>::kun-video{src="data:text/html,alert(1)"}</p>',
      introduction:
        '<p>::kun-video{src="data:text/html,&#x3C;script>alert(1)&#x3C;/script>"}</p>'
    }
  },
  {
    id: 'xss-kun-link-text-html',
    tags: ['xss', 'directive'],
    markdown:
      '::kun-link{href="https://a.example" text="<img src=x onerror=alert(1)>"}',
    html: {
      comment: '',
      note: '<p>::kun-link{href="<a href="https://a.example" data-kun-external-link="" data-href="https://a.example" data-text="https://a.example">https://a.example</a>" text=""}</p>',
      introduction: {
        includes: [
          '<div data-kun-link=""',
          '<a href="https://a.example"',
          '<div class="m-0">&#x3C;img src=x onerror=alert(1)></div>'
        ],
        excludes: ['<img']
      }
    }
  },
  {
    id: 'xss-kun-video-extra-attributes',
    tags: ['xss', 'directive'],
    markdown:
      '::kun-video{src="https://a.example/v.mp4" onclick="alert(1)" style="position:fixed" class="evil" id="x"}',
    html: {
      comment: '',
      note: '<p>::kun-video{src="<a href="https://a.example/v.mp4" data-kun-external-link="" data-href="https://a.example/v.mp4" data-text="https://a.example/v.mp4">https://a.example/v.mp4</a>" onclick="alert(1)" style="position:fixed" class="evil" id="x"}</p>',
      introduction: {
        includes: [
          '<div data-video-player=""',
          'data-src="https://a.example/v.mp4"'
        ],
        excludes: ['onclick', 'position:fixed', 'evil', 'id="x"']
      }
    }
  },

  // ---- 普通文字里的半角冒号 (P11-01 / P24-01 / P24-02) ----
  {
    id: 'colon-time',
    tags: ['colon', 'plain'],
    markdown: '发售时间 10:30 开始',
    html: '<p>发售时间 10:30 开始</p>'
  },
  {
    id: 'colon-note',
    tags: ['colon', 'plain'],
    markdown: '注:这个补丁很好',
    html: '<p>注:这个补丁很好</p>'
  },
  {
    id: 'colon-latin',
    tags: ['colon', 'plain'],
    markdown: 'Re:Zero 是一部作品',
    html: '<p>Re:Zero 是一部作品</p>'
  },
  {
    id: 'colon-cv',
    tags: ['colon', 'plain'],
    markdown: '主角 CV:花澤香菜',
    html: '<p>主角 CV:花澤香菜</p>'
  },
  {
    id: 'colon-ratio',
    tags: ['colon', 'plain'],
    markdown: '比例 16:9 屏幕',
    html: '<p>比例 16:9 屏幕</p>'
  },
  {
    id: 'colon-magnet-text',
    tags: ['colon', 'plain'],
    markdown: 'magnet:?xt=urn:btih:5d3fab0c1e',
    html: '<p>magnet:?xt=urn:btih:5d3fab0c1e</p>'
  },
  {
    id: 'colon-shortcode',
    tags: ['colon', 'plain'],
    markdown: ':smile: 开心 :+1:',
    html: '<p>:smile: 开心 :+1:</p>'
  },
  {
    id: 'colon-fullwidth',
    tags: ['colon', 'plain'],
    markdown: '时间：10：30',
    html: '<p>时间：10：30</p>'
  },
  {
    id: 'colon-escaped',
    tags: ['colon'],
    markdown: '时间 10\\:30 开始',
    html: '<p>时间 10:30 开始</p>'
  },
  {
    id: 'colon-attributes',
    tags: ['colon'],
    markdown: '比例 16:9{.wide} 屏幕',
    html: '<p>比例 16:9{.wide} 屏幕</p>'
  },
  {
    id: 'colon-label',
    tags: ['colon'],
    markdown: 'a:b[**c**] d',
    html: '<p>a:b[<strong>c</strong>] d</p>'
  },
  {
    id: 'colon-label-link',
    tags: ['colon'],
    markdown: 'Re:Zero[1](https://x.example/a) 后文',
    html: '<p>Re:Zero<a href="https://x.example/a" data-kun-external-link="" data-href="https://x.example/a" data-text="1">1</a> 后文</p>'
  },
  {
    id: 'colon-in-strong',
    tags: ['colon'],
    markdown: '**Re:Zero** 粗体',
    html: '<p><strong>Re:Zero</strong> 粗体</p>'
  },
  {
    id: 'colon-before-strong',
    tags: ['colon'],
    markdown: 'CV:花澤香菜**粗体**',
    html: '<p>CV:花澤香菜<strong>粗体</strong></p>'
  },
  {
    id: 'colon-in-link-text',
    tags: ['colon'],
    markdown: '[Re:Zero](https://example.com/re)',
    html: '<p><a href="https://example.com/re" data-kun-external-link="" data-href="https://example.com/re" data-text="Re:Zero">Re:Zero</a></p>'
  },
  {
    id: 'colon-in-url',
    tags: ['colon'],
    markdown: '见 https://example.com/a:b 与 <https://a.example/x:y>',
    html: '<p>见 <a href="https://example.com/a:b" data-kun-external-link="" data-href="https://example.com/a:b" data-text="https://example.com/a:b">https://example.com/a:b</a> 与 <a href="https://a.example/x:y" data-kun-external-link="" data-href="https://a.example/x:y" data-text="https://a.example/x:y">https://a.example/x:y</a></p>'
  },
  {
    id: 'colon-in-code',
    tags: ['colon'],
    markdown: '`10:30` 与\n\n```\nCV:花澤香菜\n```',
    html: '<p><code>10:30</code> 与</p>\n<pre><code>CV:花澤香菜\n</code></pre>'
  },
  {
    id: 'colon-in-blocks',
    tags: ['colon'],
    markdown:
      '# CV:花澤香菜\n\n- 16:9\n\n> 注:说明\n\n| a:b |\n| --- |\n| c:d |',
    html: '<h1>CV:花澤香菜</h1>\n<ul>\n<li>16:9</li>\n</ul>\n<blockquote>\n<p>注:说明</p>\n</blockquote>\n<table>\n<thead>\n<tr>\n<th>a:b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>c:d</td>\n</tr>\n</tbody>\n</table>'
  },

  // ---- 指令 ----
  {
    id: 'directive-video',
    tags: ['directive'],
    markdown: '::kun-video{src="https://cdn.example.com/a.mp4"}',
    html: {
      comment: '',
      note: '<p>::kun-video{src="<a href="https://cdn.example.com/a.mp4%22%7D" data-kun-external-link="" data-href="https://cdn.example.com/a.mp4%22%7D" data-text="https://cdn.example.com/a.mp4&#x22;}">https://cdn.example.com/a.mp4"}</a></p>',
      introduction: {
        includes: [
          '<div data-video-player=""',
          'data-src="https://cdn.example.com/a.mp4"'
        ]
      }
    }
  },
  {
    id: 'directive-link',
    tags: ['directive'],
    markdown: '::kun-link{href="https://www.example.com/x" text="支持正版"}',
    html: {
      comment: '',
      note: '<p>::kun-link{href="<a href="https://www.example.com/x" data-kun-external-link="" data-href="https://www.example.com/x" data-text="https://www.example.com/x">https://www.example.com/x</a>" text="支持正版"}</p>',
      introduction: {
        includes: [
          '<div data-kun-link=""',
          '<a href="https://www.example.com/x"',
          '<div class="m-0">支持正版</div>'
        ]
      }
    }
  },
  {
    id: 'directive-link-with-label',
    tags: ['directive'],
    markdown:
      '::kun-link[支持正版]{href="https://www.example.com/x" text="支持正版"}',
    html: {
      comment: '',
      note: '<p>::kun-link[支持正版]{href="<a href="https://www.example.com/x" data-kun-external-link="" data-href="https://www.example.com/x" data-text="https://www.example.com/x">https://www.example.com/x</a>" text="支持正版"}</p>',
      introduction: {
        includes: [
          '<div data-kun-link=""',
          '<a href="https://www.example.com/x"',
          '<div class="m-0">支持正版</div>'
        ]
      }
    }
  },
  {
    id: 'directive-between-paragraphs',
    tags: ['directive'],
    markdown:
      '前言\n\n::kun-video{src="https://cdn.example.com/a.mp4"}\n\n后记',
    html: {
      comment: '<p>前言</p>\n<p>后记</p>',
      note: '<p>前言</p>\n<p>::kun-video{src="<a href="https://cdn.example.com/a.mp4%22%7D" data-kun-external-link="" data-href="https://cdn.example.com/a.mp4%22%7D" data-text="https://cdn.example.com/a.mp4&#x22;}">https://cdn.example.com/a.mp4"}</a></p>\n<p>后记</p>',
      introduction: {
        includes: [
          '<p>前言</p>\n<div data-video-player=""',
          'data-src="https://cdn.example.com/a.mp4"',
          '</div>\n<p>后记</p>'
        ]
      }
    }
  },
  {
    id: 'directive-link-missing-text',
    tags: ['directive'],
    markdown: '::kun-link{href="https://a.example"}',
    html: {
      comment:
        '<p>::kun-link{href="<a href="https://a.example" data-kun-external-link="" data-href="https://a.example" data-text="https://a.example">https://a.example</a>"}</p>',
      note: '<p>::kun-link{href="<a href="https://a.example%22%7D" data-kun-external-link="" data-href="https://a.example%22%7D" data-text="https://a.example&#x22;}">https://a.example"}</a></p>',
      introduction:
        '<p>::kun-link{href="<a href="https://a.example" data-kun-external-link="" data-href="https://a.example" data-text="https://a.example">https://a.example</a>"}</p>'
    }
  },
  {
    id: 'directive-link-blank',
    tags: ['directive'],
    markdown:
      '## 支持正版\n\n::kun-link{href="" text="点我前往购买, 游戏官网可能需要代理打开"}',
    html: {
      comment: '<h2>支持正版</h2>',
      note: '<h2>支持正版</h2>\n<p>::kun-link{href="" text="点我前往购买, 游戏官网可能需要代理打开"}</p>',
      introduction: '<h2>支持正版</h2>'
    }
  },
  {
    id: 'directive-video-blank',
    tags: ['directive'],
    markdown: '前言\n\n::kun-video{src=""}\n\n后记',
    html: {
      comment: '<p>前言</p>\n<p>后记</p>',
      note: '<p>前言</p>\n<p>::kun-video{src=""}</p>\n<p>后记</p>',
      introduction: '<p>前言</p>\n<p>后记</p>'
    }
  },
  {
    id: 'directive-video-unquoted',
    tags: ['directive'],
    markdown: '::kun-video{src=https://a.example/v.mp4}',
    html: {
      comment: '',
      note: '<p>::kun-video{src=<a href="https://a.example/v.mp4%7D" data-kun-external-link="" data-href="https://a.example/v.mp4%7D" data-text="https://a.example/v.mp4}">https://a.example/v.mp4}</a></p>',
      introduction: {
        includes: [
          '<div data-video-player=""',
          'data-src="https://a.example/v.mp4"'
        ]
      }
    }
  },
  {
    id: 'directive-video-relative',
    tags: ['directive'],
    markdown: '::kun-video{src="/local/v.mp4"}',
    html: {
      comment: '',
      note: '<p>::kun-video{src="/local/v.mp4"}</p>',
      introduction: {
        includes: ['<div data-video-player=""', 'data-src="/local/v.mp4"']
      }
    }
  },
  {
    id: 'directive-link-entities',
    tags: ['directive'],
    markdown:
      '::kun-link{href="https://a.example/?a=1&amp;b=2" text="a &amp; b"}',
    html: {
      comment: '',
      note: '<p>::kun-link{href="<a href="https://a.example/?a=1&#x26;amp;b=2" data-kun-external-link="" data-href="https://a.example/?a=1&#x26;amp;b=2" data-text="https://a.example/?a=1&#x26;amp;b=2">https://a.example/?a=1&#x26;amp;b=2</a>" text="a &#x26; b"}</p>',
      introduction: {
        includes: [
          '<div data-kun-link=""',
          '<a href="https://a.example/?a=1&#x26;b=2"',
          '<div class="m-0">a &#x26; b</div>'
        ]
      }
    }
  },
  {
    id: 'directive-name-uppercase',
    tags: ['directive'],
    markdown: '::KUN-VIDEO{src="https://a.example/v.mp4"}',
    html: {
      comment:
        '<p>::KUN-VIDEO{src="<a href="https://a.example/v.mp4" data-kun-external-link="" data-href="https://a.example/v.mp4" data-text="https://a.example/v.mp4">https://a.example/v.mp4</a>"}</p>',
      note: '<p>::KUN-VIDEO{src="<a href="https://a.example/v.mp4%22%7D" data-kun-external-link="" data-href="https://a.example/v.mp4%22%7D" data-text="https://a.example/v.mp4&#x22;}">https://a.example/v.mp4"}</a></p>',
      introduction:
        '<p>::KUN-VIDEO{src="<a href="https://a.example/v.mp4" data-kun-external-link="" data-href="https://a.example/v.mp4" data-text="https://a.example/v.mp4">https://a.example/v.mp4</a>"}</p>'
    }
  },
  {
    id: 'directive-inline-kun-link',
    tags: ['directive'],
    markdown: '前文 :kun-link{href="https://a.example" text="t"} 后文',
    html: '<p>前文 :kun-link{href="<a href="https://a.example" data-kun-external-link="" data-href="https://a.example" data-text="https://a.example">https://a.example</a>" text="t"} 后文</p>'
  },
  {
    id: 'directive-inline-kun-video',
    tags: ['directive'],
    markdown: '前文 :kun-video{src="https://a.example/v.mp4"} 后文',
    html: '<p>前文 :kun-video{src="<a href="https://a.example/v.mp4%22%7D" data-kun-external-link="" data-href="https://a.example/v.mp4%22%7D" data-text="https://a.example/v.mp4&#x22;}">https://a.example/v.mp4"}</a> 后文</p>'
  },
  {
    id: 'directive-midline-double-colon',
    tags: ['directive'],
    markdown: '前文 ::kun-video{src="https://a.example/v.mp4"} 后文',
    html: '<p>前文 ::kun-video{src="<a href="https://a.example/v.mp4%22%7D" data-kun-external-link="" data-href="https://a.example/v.mp4%22%7D" data-text="https://a.example/v.mp4&#x22;}">https://a.example/v.mp4"}</a> 后文</p>'
  },
  {
    id: 'directive-unknown-leaf',
    tags: ['directive'],
    markdown: '::foo{bar=1}',
    html: '<p>::foo{bar=1}</p>'
  },
  {
    id: 'directive-unknown-leaf-label',
    tags: ['directive'],
    markdown: '::foo[标签 **粗体**]{bar=1}',
    html: {
      comment: '<p>::foo[标签 **粗体**]{bar=1}</p>',
      note: '<p>::foo[标签 <strong>粗体</strong>]{bar=1}</p>',
      introduction: '<p>::foo[标签 **粗体**]{bar=1}</p>'
    }
  },
  {
    id: 'directive-container',
    tags: ['directive'],
    markdown: ':::note\n内容\n:::',
    html: {
      comment: '<p>:::note</p>\n<p>内容</p>\n<p>:::</p>',
      note: '<p>:::note\n内容\n:::</p>',
      introduction: '<p>:::note</p>\n<p>内容</p>\n<p>:::</p>'
    }
  },
  {
    id: 'directive-container-label',
    tags: ['directive'],
    markdown: ':::note[标题]\n内容\n:::',
    html: {
      comment: '<p>:::note[标题]</p>\n<p>内容</p>\n<p>:::</p>',
      note: '<p>:::note[标题]\n内容\n:::</p>',
      introduction: '<p>:::note[标题]</p>\n<p>内容</p>\n<p>:::</p>'
    }
  },
  {
    id: 'directive-container-unclosed',
    tags: ['directive'],
    markdown: ':::spoiler\n剧透内容',
    html: {
      comment: '<p>:::spoiler</p>\n<p>剧透内容</p>',
      note: '<p>:::spoiler\n剧透内容</p>',
      introduction: '<p>:::spoiler</p>\n<p>剧透内容</p>'
    }
  },
  {
    id: 'directive-container-nested',
    tags: ['directive'],
    markdown: '::::outer\n:::inner\n内容\n:::\n::::',
    html: {
      comment:
        '<p>::::outer</p>\n<p>:::inner</p>\n<p>内容</p>\n<p>:::</p>\n<p>::::</p>',
      note: '<p>::::outer\n:::inner\n内容\n:::\n::::</p>',
      introduction:
        '<p>::::outer</p>\n<p>:::inner</p>\n<p>内容</p>\n<p>:::</p>\n<p>::::</p>'
    }
  },
  {
    id: 'directive-container-kun-video',
    tags: ['directive'],
    markdown: ':::kun-video{src="https://a.example/v.mp4"}\n内容\n:::',
    html: {
      comment:
        '<p>:::kun-video{src="<a href="https://a.example/v.mp4" data-kun-external-link="" data-href="https://a.example/v.mp4" data-text="https://a.example/v.mp4">https://a.example/v.mp4</a>"}</p>\n<p>内容</p>\n<p>:::</p>',
      note: '<p>:::kun-video{src="<a href="https://a.example/v.mp4%22%7D" data-kun-external-link="" data-href="https://a.example/v.mp4%22%7D" data-text="https://a.example/v.mp4&#x22;}">https://a.example/v.mp4"}</a>\n内容\n:::</p>',
      introduction:
        '<p>:::kun-video{src="<a href="https://a.example/v.mp4" data-kun-external-link="" data-href="https://a.example/v.mp4" data-text="https://a.example/v.mp4">https://a.example/v.mp4</a>"}</p>\n<p>内容</p>\n<p>:::</p>'
    }
  },
  {
    id: 'directive-in-blockquote',
    tags: ['directive'],
    markdown:
      '> ::kun-video{src="https://a.example/v.mp4"}\n>\n> :::note\n> 内容\n> :::',
    html: {
      comment:
        '<blockquote>\n<p>:::note</p>\n<p>内容</p>\n<p>:::</p>\n</blockquote>',
      note: '<blockquote>\n<p>::kun-video{src="<a href="https://a.example/v.mp4%22%7D" data-kun-external-link="" data-href="https://a.example/v.mp4%22%7D" data-text="https://a.example/v.mp4&#x22;}">https://a.example/v.mp4"}</a></p>\n<p>:::note\n内容\n:::</p>\n</blockquote>',
      introduction: {
        includes: [
          '<blockquote>\n<div data-video-player=""',
          'data-src="https://a.example/v.mp4"',
          '</div>\n<p>:::note</p>\n<p>内容</p>\n<p>:::</p>\n</blockquote>'
        ]
      }
    }
  },
  {
    id: 'directive-in-list',
    tags: ['directive'],
    markdown: '- ::foo\n- ::kun-link{href="https://a.example" text="t"}',
    html: {
      comment: '<ul>\n<li>::foo</li>\n<li></li>\n</ul>',
      note: '<ul>\n<li>::foo</li>\n<li>::kun-link{href="<a href="https://a.example" data-kun-external-link="" data-href="https://a.example" data-text="https://a.example">https://a.example</a>" text="t"}</li>\n</ul>',
      introduction: {
        includes: [
          '<ul>\n<li>::foo</li>\n<li>',
          '<div data-kun-link=""',
          '<a href="https://a.example"'
        ]
      }
    }
  },
  {
    id: 'directive-in-code',
    tags: ['directive'],
    markdown:
      '```\n::kun-video{src="https://a.example/v.mp4"}\n```\n\n    ::foo',
    html: '<pre><code>::kun-video{src="https://a.example/v.mp4"}\n</code></pre>\n<pre><code>::foo\n</code></pre>'
  },

  // ---- GFM 与常规语法 ----
  {
    id: 'gfm-inline',
    tags: ['gfm'],
    markdown: '**bold _em `code`_** ~~del~~ 行内  \n换行 &amp; &#35; &copy;',
    html: '<p><strong>bold <em>em <code>code</code></em></strong> <del>del</del> 行内<br>\n换行 &#x26; # ©</p>'
  },
  {
    id: 'gfm-nested-blocks',
    tags: ['gfm'],
    markdown: '> quote\n>> deeper\n\n- a\n  - b\n    1. c',
    html: '<blockquote>\n<p>quote</p>\n<blockquote>\n<p>deeper</p>\n</blockquote>\n</blockquote>\n<ul>\n<li>a\n<ul>\n<li>b\n<ol>\n<li>c</li>\n</ol>\n</li>\n</ul>\n</li>\n</ul>'
  },
  {
    id: 'gfm-table',
    tags: ['gfm'],
    markdown: '| a | b |\n|:--|--:|\n| 1 | 2 |',
    html: '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>',
    knownBad: { defect: '09-03 #5 待裁定: 净化剥掉了 align, 列对齐不生效' }
  },
  {
    id: 'gfm-task-list',
    tags: ['gfm'],
    markdown: '- [x] done\n- [ ] todo',
    html: '<ul>\n<li><input disabled type="checkbox"> done</li>\n<li><input disabled type="checkbox"> todo</li>\n</ul>',
    knownBad: {
      defect: '09-03 #5 待裁定: 净化剥掉了 checked, 已勾选的任务显示为未勾选'
    }
  },
  {
    id: 'gfm-ordered-start',
    tags: ['gfm'],
    markdown: '5. five\n6. six',
    html: '<ol>\n<li>five</li>\n<li>six</li>\n</ol>',
    knownBad: { defect: '09-03 #5 待裁定: 净化剥掉了 start, 列表从 1 开始编号' }
  },
  {
    id: 'gfm-autolink',
    tags: ['gfm'],
    markdown: 'www.example.com 与 https://example.com/a?b=1 与 a@example.com',
    html: '<p><a href="http://www.example.com" data-kun-external-link="" data-href="http://www.example.com" data-text="www.example.com">www.example.com</a> 与 <a href="https://example.com/a?b=1" data-kun-external-link="" data-href="https://example.com/a?b=1" data-text="https://example.com/a?b=1">https://example.com/a?b=1</a> 与 <a href="mailto:a@example.com" data-kun-external-link="" data-href="mailto:a@example.com" data-text="a@example.com">a@example.com</a></p>'
  },
  {
    id: 'gfm-link-protocols',
    tags: ['gfm'],
    markdown:
      '[站内](/doc) [磁力](magnet:?xt=urn:btih:abc) [邮件](mailto:a@example.com) [ftp](ftp://a.example/x)',
    html: '<p><a href="/doc" data-kun-external-link="" data-href="/doc" data-text="站内">站内</a> <a href="magnet:?xt=urn:btih:abc" data-kun-external-link="" data-href="magnet:?xt=urn:btih:abc" data-text="磁力">磁力</a> <a href="mailto:a@example.com" data-kun-external-link="" data-href="mailto:a@example.com" data-text="邮件">邮件</a> <a>ftp</a></p>'
  },
  {
    id: 'gfm-link-title',
    tags: ['gfm'],
    markdown: '[t](https://a.example "title")',
    html: '<p><a href="https://a.example" data-kun-external-link="" data-href="https://a.example" data-text="t">t</a></p>',
    knownBad: { defect: '09-03 #5 待裁定: 净化剥掉了链接的 title' }
  },
  {
    id: 'gfm-image',
    tags: ['gfm'],
    markdown: '![图](https://a.example/a.png "标题")',
    html: '<p><img src="https://a.example/a.png" alt="图" title="标题" loading="lazy" decoding="async"></p>'
  },
  {
    id: 'gfm-code-fence',
    tags: ['gfm'],
    markdown: '```js {1-3}\nconst a = 1 < 2\n```',
    html: '<pre><code>const a = 1 &#x3C; 2\n</code></pre>'
  },
  {
    id: 'gfm-footnote',
    tags: ['gfm'],
    markdown: '脚注[^1]\n\n[^1]: 注释',
    html: '<p>脚注<sup><a href="#user-content-fn-1" data-kun-external-link="" data-href="#user-content-fn-1" data-text="1">1</a></sup></p>\n<section><h2>Footnotes</h2>\n<ol>\n<li>\n<p>注释 <a href="#user-content-fnref-1" class="data-footnote-backref" data-kun-external-link="" data-href="#user-content-fnref-1" data-text="↩">↩</a></p>\n</li>\n</ol>\n</section>',
    knownBad: {
      defect:
        '09-03 #5 待裁定: 净化剥掉了 id, 脚注的引用与回链都指向不存在的锚点',
      violates: ['fragment-target']
    }
  },
  {
    id: 'gfm-inline-html',
    tags: ['gfm'],
    markdown: '<b>x</b> <kbd>Ctrl</kbd> 文字<br>下一行',
    html: '<p>x Ctrl 文字下一行</p>'
  },
  {
    id: 'gfm-screenshot-section',
    tags: ['gfm'],
    markdown:
      '## 游戏截图\n\n![a](https://a.example/a.png)\n\n![b](https://a.example/b.png)\n\n## 其他\n\n正文',
    html: {
      comment:
        '<h2>游戏截图</h2>\n<p><img src="https://a.example/a.png" alt="a" loading="lazy" decoding="async"></p>\n<p><img src="https://a.example/b.png" alt="b" loading="lazy" decoding="async"></p>\n<h2>其他</h2>\n<p>正文</p>',
      note: '<h2>游戏截图</h2>\n<p><img src="https://a.example/a.png" alt="a" loading="lazy" decoding="async"></p>\n<p><img src="https://a.example/b.png" alt="b" loading="lazy" decoding="async"></p>\n<h2>其他</h2>\n<p>正文</p>',
      introduction:
        '<h2>游戏截图</h2><div class="data-kun-img-container"><p><img src="https://a.example/a.png" alt="a" loading="lazy" decoding="async"></p><p><img src="https://a.example/b.png" alt="b" loading="lazy" decoding="async"></p></div>\n\n\n<h2>其他</h2>\n<p>正文</p>'
    }
  },

  // ---- 文首的 --- ----
  {
    id: 'frontmatter-yaml',
    tags: ['frontmatter'],
    markdown: '---\n剧透警告\n---\n正文',
    html: '<p>正文</p>',
    knownBad: {
      defect: 'frontmatter 去留待裁定: 文首两行 --- 之间的内容整段不显示'
    }
  },
  {
    id: 'frontmatter-unclosed',
    tags: ['frontmatter'],
    markdown: '---\n只有开头\n\n正文',
    html: '<hr>\n<p>只有开头</p>\n<p>正文</p>'
  },
  {
    id: 'frontmatter-thematic-break',
    tags: ['frontmatter'],
    markdown: '正文\n\n---\n\n后文',
    html: '<p>正文</p>\n<hr>\n<p>后文</p>'
  }
]
