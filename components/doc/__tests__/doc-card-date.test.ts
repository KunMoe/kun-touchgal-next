import { createElement } from 'react'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KunNowProvider } from '~/components/kun/KunNowProvider'
import { KunAboutCard } from '../Card'

// /doc 是 force-static, 根布局下发的服务端 now 在这里是构建时刻: 卡片若显示相对时间,
// SSR 文本会停在构建那一刻, 跨档后错到下次构建 (无 JS 访问者与爬虫看到的就是错的),
// 水合后还会跳变. 与文章页 BlogHeader 一致显示绝对日期, 与 now 无关
const renderCardAt = (now: number) =>
  renderToStaticMarkup(
    createElement(
      KunNowProvider,
      { now } as ComponentProps<typeof KunNowProvider>,
      createElement(KunAboutCard, {
        post: {
          title: 'kun-doc',
          banner: '/kun-doc.webp',
          date: '2026-05-11T00:00:00.000Z',
          description: '',
          textCount: 1,
          slug: 'notice/kun-doc',
          path: 'notice/kun-doc'
        }
      })
    )
  )

describe('/doc 卡片日期不依赖服务端 now', () => {
  it('构建期与请求期 now 不同, SSR 输出同一个绝对日期', () => {
    const buildTime = Date.UTC(2026, 8, 26, 4, 0, 0)
    const muchLater = Date.UTC(2027, 2, 1, 0, 0, 0)

    const atBuild = renderCardAt(buildTime)
    expect(atBuild).toContain('<time>2026-05-11</time>')
    expect(atBuild).not.toContain('前')
    expect(renderCardAt(muchLater)).toBe(atBuild)
  })
})
