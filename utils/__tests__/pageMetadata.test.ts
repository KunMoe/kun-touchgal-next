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
})
