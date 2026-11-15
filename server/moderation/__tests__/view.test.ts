import { beforeAll, describe, expect, it, vi } from 'vitest'

// 介绍管线对哨兵输入抛错, 其余照常渲染: 用来验证渲染失败时的回退
vi.mock(
  import('~/app/api/utils/render/markdownToHtml'),
  async (importOriginal) => {
    const original = await importOriginal()
    return {
      ...original,
      markdownToHtml: async (markdown: string) => {
        if (markdown.includes('__RENDER_FAILS__')) {
          throw new RangeError('Maximum call stack size exceeded')
        }
        return original.markdownToHtml(markdown)
      }
    }
  }
)

import { matchBlacklist, normalizeModerationText } from '../prefilter'
import {
  bioSubject,
  commentSubject,
  ratingSubject,
  resourceSubject
} from '../subject'
import { buildAuditView } from '../view'

// 不配 Redis: 渲染走真实管线但不经缓存, 测试不触网
beforeAll(() => {
  vi.stubEnv('REDIS_HOST', '')
  vi.stubEnv('REDIS_PORT', '')
})

const viewOfComment = async (markdown: string) =>
  (await buildAuditView(commentSubject(markdown)))[0]

// worker 对每段的「读者所见」与「原文」都做黑名单匹配
const blacklistHits = async (markdown: string, pattern: string) => {
  const { shown, source } = await viewOfComment(markdown)
  return [shown, source ?? ''].some(
    (text) => matchBlacklist(normalizeModerationText(text), [pattern]) !== null
  )
}

describe('buildAuditView: plain 段', () => {
  it('原样送审, 不做任何降噪改写', async () => {
    expect(
      await buildAuditView(bioSubject('<加QQ群987654321> data:1;base64,123'))
    ).toEqual([{ label: '签名', shown: '<加QQ群987654321> data:1;base64,123' }])
  })

  it('没有可见文字的段不出现在视图里', async () => {
    expect(await buildAuditView(ratingSubject('\u200B \n'))).toEqual([])
    expect(
      await buildAuditView(
        resourceSubject({ name: '  ', note: 'note', modelName: '', links: [] })
      )
    ).toEqual([{ label: '介绍', shown: 'note' }])
  })

  it('每段各自按该字段的写入上限截断, 按码点、不劈开代理对', async () => {
    // 评价上限 1314; 用平面外字符验证按码点而非 UTF-16 码元
    const [segment] = await buildAuditView(ratingSubject('😀'.repeat(2000)))

    expect([...segment.shown]).toHaveLength(1314)
    expect(segment.shown.isWellFormed()).toBe(true)
  })

  it('长文介绍排在标题、型号与各条链接之后', async () => {
    const view = await buildAuditView(
      resourceSubject({
        name: 'Patch v1',
        note: '说明',
        modelName: 'GPT-4o',
        links: [
          {
            storage: 'mega',
            content: 'https://pan.example/s/abc',
            code: 'abcd',
            password: ''
          },
          { storage: 's3', content: 'generated', code: '', password: 'pw' }
        ]
      })
    )

    expect(view).toEqual([
      { label: '标题', shown: 'Patch v1' },
      { label: '模型型号', shown: 'GPT-4o' },
      { label: '链接 1', shown: 'https://pan.example/s/abc' },
      { label: '提取码 1', shown: 'abcd' },
      { label: '解压码 2', shown: 'pw' },
      { label: '介绍', shown: '说明' }
    ])
  })

  it('带序号的链接字段同样按写入上限截断', async () => {
    const [, link] = await buildAuditView({
      contentType: 'resource',
      segments: [
        { label: '标题', kind: 'plain', value: 'T' },
        { label: '解压码 2', kind: 'plain', value: '密'.repeat(3000) }
      ]
    })

    expect([...link.shown]).toHaveLength(1007)
  })
})

describe('buildAuditView: markdown 段审「读者所见 + 原文」两面', () => {
  it('渲染结果与原文等价时只送原文', async () => {
    expect(await viewOfComment('第一段\n\n第二段')).toEqual({
      label: '评论',
      shown: '第一段\n\n第二段'
    })
  })

  // X09-01: 旧实现把 200 字符内的任意 <…> 当标签剥掉, 这类文本对审核完全不可见
  it.each([
    ['整段包进尖括号的引流文本', '<加QQ群987654321，资源多多>'],
    ['小于号与大于号之间的正文', 'a < 987654321 and c > d']
  ])('%s: 原样可见, 黑名单命中', async (_name, markdown) => {
    expect((await viewOfComment(markdown)).shown).toBe(markdown)
    expect(await blacklistHits(markdown, '987654321')).toBe(true)
  })

  // X09-02: 旧实现按字符集把它整段替换成「[图片]」
  it('伪装成 base64 的数字串不再被替换成占位, 黑名单命中', async () => {
    const markdown = '好东西都在这 data:1;base64,987654321'
    const { shown, source } = await viewOfComment(markdown)

    expect(shown).toContain('987654321')
    expect(shown).not.toContain('[图片]')
    expect(source).toBe(markdown)
    expect(await blacklistHits(markdown, '987654321')).toBe(true)
  })

  it('行内标记拆开的词: 投影里连成读者看到的样子, 原文一并保留', async () => {
    expect(await viewOfComment('加群 98**76**54321')).toEqual({
      label: '评论',
      shown: '加群 987654321',
      source: '加群 98**76**54321'
    })
    expect(await blacklistHits('加群 98**76**54321', '987654321')).toBe(true)
  })

  it('内嵌标签拆开的词同样由投影接住', async () => {
    expect((await viewOfComment('加群 98<span>76</span>54321')).shown).toBe(
      '加群 987654321'
    )
    expect(
      await blacklistHits('加群 98<span>76</span>54321', '987654321')
    ).toBe(true)
  })

  it('自动链接与引用式链接定义: 投影给出读者点得到的地址', async () => {
    expect(await viewOfComment('官网 <https://evil.example/a>')).toEqual({
      label: '评论',
      shown: '官网 https://evil.example/a',
      source: '官网 <https://evil.example/a>'
    })
    expect(
      (await viewOfComment('参考 [1]\n\n[1]: <https://evil.example/ref>')).shown
    ).toBe('参考 1 [https://evil.example/ref]')
  })

  // 这些内容渲染后不可见, 但原文会原样出现在通知与个人主页里
  it('HTML 注释: 页面上不可见, 原文仍送审', async () => {
    expect(await viewOfComment('正常评论<!-- 加群 987654321 -->')).toEqual({
      label: '评论',
      shown: '正常评论',
      source: '正常评论<!-- 加群 987654321 -->'
    })
    expect(
      await blacklistHits('正常评论<!-- 加群 987654321 -->', '987654321')
    ).toBe(true)
  })

  it.each([
    ['容器指令', ':::note\n加群987654321\n:::'],
    ['叶子指令', '::kun-x[加群987654321]'],
    ['HTML 块', '<div>\n加群987654321\n</div>']
  ])('%s渲染为空时只送原文', async (_name, markdown) => {
    expect(await viewOfComment(markdown)).toEqual({
      label: '评论',
      shown: markdown
    })
    expect(await blacklistHits(markdown, '987654321')).toBe(true)
  })

  // X17-01: 旧实现按 UTF-16 头尾截断, 切点劈开代理对后 jsonb 拒收整份载荷
  it('大量平面外字符不产生孤立代理', async () => {
    const { shown, source } = await viewOfComment(`a${'😀'.repeat(6100)}`)

    expect(shown.isWellFormed()).toBe(true)
    expect(source?.isWellFormed() ?? true).toBe(true)
    expect([...shown]).toHaveLength(6101)
  })

  it('资源介绍走介绍的渲染管线', async () => {
    const view = await buildAuditView(
      resourceSubject({
        name: 'Patch v1',
        note: '下载见 [网盘](https://pan.example/s/abc)',
        modelName: '',
        links: []
      })
    )

    expect(view).toEqual([
      { label: '标题', shown: 'Patch v1' },
      {
        label: '介绍',
        shown: '下载见 网盘 [https://pan.example/s/abc]',
        source: '下载见 [网盘](https://pan.example/s/abc)'
      }
    ])
  })

  it('渲染抛错时只送原文, 不让任务失败', async () => {
    const view = await buildAuditView(
      resourceSubject({
        name: 'Patch v1',
        note: '__RENDER_FAILS__ 加群 98**76**54321',
        modelName: '',
        links: []
      })
    )

    expect(view[1]).toEqual({
      label: '介绍',
      shown: '__RENDER_FAILS__ 加群 98**76**54321'
    })
  })
})

describe('buildAuditView: 引入主体之前的旧任务', () => {
  it('单个 plain 段原样使用, 不再限长', async () => {
    // 比任何字段的写入上限都长: 旧任务的文本在写入时已经限过长, 这里不能再截
    const text = `标题: A 介绍: ${'字'.repeat(11000)}`

    expect(
      await buildAuditView({
        contentType: 'resource',
        segments: [{ label: '正文', kind: 'plain', value: text }]
      })
    ).toEqual([{ label: '正文', shown: text }])
  })
})
