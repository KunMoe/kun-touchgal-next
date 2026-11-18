import { describe, expect, it } from 'vitest'
import { KUN_MARKDOWN_PROFILES } from '~/app/api/utils/render/profiles'
import { renderKunMarkdown } from '~/app/api/utils/render/renderKunMarkdown'

// 一页上同时有简介、每条评论、每条资源备注, 各自独立渲染后放进同一份文档。
// 脚注的锚点如果只按脚注名字生成, 两段内容都写 [^1] 就会撞 id: 后一段的脚注链接
// 跳进前一段里, 排在前面的人可以让别人的脚注指向自己写的文字

const render = async (markdown: string) =>
  (await renderKunMarkdown('comment', markdown, { cache: false })).html

const idsOf = (html: string) =>
  [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1])

const fragmentsOf = (html: string) =>
  [...html.matchAll(/ href="#([^"]+)"/g)].map((match) => match[1])

describe('脚注锚点只在自己这一段内容里解析', () => {
  it('两段内容用同一个脚注名字, 锚点互不相同', async () => {
    const first = await render('官方下载见脚注[^1]\n\n[^1]: 请到资源页下载')
    const second = await render('顶[^1]\n\n[^1]: 新地址见个人主页')

    expect(idsOf(first)).toHaveLength(2)
    expect(idsOf(second)).toHaveLength(2)
    expect(idsOf(first).filter((id) => idsOf(second).includes(id))).toEqual([])
  })

  it('每段的引用与回链都落在本段的锚点上', async () => {
    for (const markdown of [
      '甲[^1] 乙[^1] 丙[^注]\n\n[^1]: 一\n\n[^注]: 二',
      '顶[^1]\n\n[^1]: 另一段'
    ]) {
      const html = await render(markdown)

      expect(fragmentsOf(html).length).toBeGreaterThan(0)
      expect(
        fragmentsOf(html).filter((fragment) => !idsOf(html).includes(fragment))
      ).toEqual([])
    }
  })

  // 落库的评论 HTML 与渲染缓存都按原文复用, 同一份原文的锚点必须是确定的
  it('同一份原文每次渲染得到同样的锚点', async () => {
    const markdown = '脚注[^1]\n\n[^1]: 注释'

    expect(await render(markdown)).toBe(await render(markdown))
  })

  it('手写的指向脚注锚点的链接同样落在本段', async () => {
    const html = await render('[看脚注](#user-content-fn-1)[^1]\n\n[^1]: 注释')

    expect(
      fragmentsOf(html).filter((fragment) => !idsOf(html).includes(fragment))
    ).toEqual([])
  })

  it('不带脚注的页内链接原样保留', async () => {
    expect(await render('[回到下载](#download)')).toBe(
      '<p><a href="#download">回到下载</a></p>'
    )
  })
})

// 净化库默认会给 id 加前缀来防止顶掉页面的全局变量。脚注锚点在上游生成时已带前缀,
// 所以这里把 id 从加前缀的名单里拿掉了 —— 代价是: 以后再放行别的 id, 它不会自动
// 带上前缀。放行 id 的地方必须自己用正则限定形状
describe('净化策略里的 id', () => {
  it.each(Object.entries(KUN_MARKDOWN_PROFILES))(
    '%s 只按脚注锚点的形状放行 id',
    (_name, profile) => {
      const definitions = Object.values(profile.schema.attributes ?? {})
        .flat()
        .filter((definition) =>
          Array.isArray(definition)
            ? definition[0] === 'id'
            : definition === 'id'
        )

      expect(definitions.length).toBeGreaterThan(0)
      for (const definition of definitions) {
        expect(Array.isArray(definition)).toBe(true)
        const pattern = (definition as unknown[])[1]
        expect(pattern).toBeInstanceOf(RegExp)
        expect((pattern as RegExp).source).toMatch(/^\^user-content-fn/)
      }
    }
  )
})
