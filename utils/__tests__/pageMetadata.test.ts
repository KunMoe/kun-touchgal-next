import { describe, expect, it } from 'vitest'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { kunDocumentTitle, kunPageMetadata } from '~/utils/pageMetadata'

describe('kunDocumentTitle', () => {
  it('套用与根布局相同的模板', () => {
    expect(kunDocumentTitle('登录')).toBe(
      kunMoyuMoe.template.replace('%s', '登录')
    )
    expect(kunDocumentTitle('登录')).toBe('登录 - TouchGal')
  })

  // 作品名与用户名来自用户输入
  it('标题里的 $ 序列原样保留', () => {
    expect(kunDocumentTitle('a$&b$$c$1')).toBe('a$&b$$c$1 - TouchGal')
  })
})

describe('kunPageMetadata', () => {
  it('只有标题时不输出其它页面级字段', () => {
    const metadata = kunPageMetadata({ title: '评论管理' })

    expect(Object.keys(metadata).sort()).toEqual([
      'openGraph',
      'title',
      'twitter'
    ])
    expect(metadata.title).toBe('评论管理')
  })

  // Next 把值为 undefined 的键也当成页面声明了它, 会清掉从根布局继承的值
  it('没有值的字段连键都不出现', () => {
    const metadata = kunPageMetadata({ title: '评论管理' })

    expect('description' in metadata).toBe(false)
    expect('keywords' in metadata).toBe(false)
    expect('description' in metadata.openGraph!).toBe(false)
    expect('description' in metadata.twitter!).toBe(false)
  })

  // 简介为空的详情页: 键要在, 值是空串, Next 才不会拿站点描述去填
  it('明确给出的空描述原样保留', () => {
    const metadata = kunPageMetadata({ title: '某会社', description: '' })

    expect(metadata.description).toBe('')
    expect(metadata.openGraph).toMatchObject({ description: '' })
    expect(metadata.twitter).toMatchObject({ description: '' })
  })

  // 测试站点靠根布局的 noindex 被继承
  it('可索引的页面不输出 robots 与 alternates', () => {
    const metadata = kunPageMetadata({ title: '登录', description: '说明' })

    expect('robots' in metadata).toBe(false)
    expect('alternates' in metadata).toBe(false)
  })

  it('描述只写一次, 社交卡片的标题带站点后缀', () => {
    const metadata = kunPageMetadata({
      title: '登录',
      description: '说明',
      keywords: ['登录']
    })

    expect(metadata.description).toBe('说明')
    expect(metadata.keywords).toEqual(['登录'])
    expect(metadata.openGraph).toMatchObject({
      title: '登录 - TouchGal',
      description: '说明',
      url: './',
      siteName: kunMoyuMoe.title,
      locale: 'zh_CN',
      type: 'website',
      images: kunMoyuMoe.images
    })
    expect(metadata.twitter).toMatchObject({
      title: '登录 - TouchGal',
      description: '说明',
      card: 'summary_large_image',
      creator: kunMoyuMoe.creator.mention,
      images: kunMoyuMoe.images
    })
  })

  it('noindex 输出 robots', () => {
    expect(
      kunPageMetadata({ title: '两步验证', noindex: true }).robots
    ).toEqual({ index: false })
  })

  it('canonicalPath 同时改规范地址与 og:url', () => {
    const metadata = kunPageMetadata({
      title: '恭喜成为创作者',
      canonicalPath: '/apply'
    })

    expect(metadata.alternates).toEqual({ canonical: '/apply' })
    expect(metadata.openGraph).toMatchObject({ url: '/apply' })
  })

  describe('social', () => {
    it('社交卡片可以有自己的标题、描述与图片, 标题照样带站点后缀', () => {
      const images = [
        { url: '/banner.avif', width: 1920, height: 1080, alt: '某作品' }
      ]
      const metadata = kunPageMetadata({
        title: '某作品 | 某别名 | PC 游戏',
        description: '页面描述',
        social: { title: '某作品 | 某别名', description: '卡片描述', images }
      })

      expect(metadata.title).toBe('某作品 | 某别名 | PC 游戏')
      expect(metadata.description).toBe('页面描述')
      expect(metadata.openGraph).toMatchObject({
        title: '某作品 | 某别名 - TouchGal',
        description: '卡片描述',
        images,
        url: './',
        siteName: kunMoyuMoe.title
      })
      expect(metadata.twitter).toMatchObject({
        title: '某作品 | 某别名 - TouchGal',
        description: '卡片描述',
        images
      })
    })

    it('不写图片时用站点的分享图', () => {
      const metadata = kunPageMetadata({
        title: '某资源',
        social: { article: {} }
      })

      expect(metadata.openGraph).toMatchObject({ images: kunMoyuMoe.images })
      expect(metadata.twitter).toMatchObject({ images: kunMoyuMoe.images })
    })

    it('article 让 og:type 变成 article, 并带上时间与标签', () => {
      const metadata = kunPageMetadata({
        title: '某会社',
        social: {
          article: {
            publishedTime: '2026-01-01T00:00:00.000Z',
            modifiedTime: '2026-01-02T00:00:00.000Z',
            tags: ['别名']
          }
        }
      })

      expect(metadata.openGraph).toMatchObject({
        type: 'article',
        publishedTime: '2026-01-01T00:00:00.000Z',
        modifiedTime: '2026-01-02T00:00:00.000Z',
        tags: ['别名'],
        url: './',
        locale: 'zh_CN'
      })
    })

    it('不写 article 时仍是 website', () => {
      expect(
        kunPageMetadata({ title: '登录', social: { title: '登录页' } })
          .openGraph
      ).toMatchObject({ type: 'website' })
    })

    it('card 只改 twitter 卡片的版式', () => {
      expect(
        kunPageMetadata({ title: '某作品', social: { card: 'summary' } })
          .twitter
      ).toMatchObject({ card: 'summary', creator: kunMoyuMoe.creator.mention })
      expect(kunPageMetadata({ title: '某文档' }).twitter).toMatchObject({
        card: 'summary_large_image'
      })
    })
  })
})
