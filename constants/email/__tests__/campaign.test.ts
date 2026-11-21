import { describe, expect, it } from 'vitest'
import {
  CAMPAIGN_TEMPLATE_IDS,
  renderCampaignEmail
} from '~/constants/email/campaign'
import {
  MAIL_CAMPAIGN_CONTENT_LIMIT,
  MAIL_CAMPAIGN_TITLE_LIMIT
} from '~/constants/admin'
import { adminSendEmailSchema } from '~/validations/admin'

const UNSUBSCRIBE_PAGE = 'https://www.example.com/auth/email-notice'

// 取出退订链接的 href, 按浏览器读属性值的规则把实体还原
const unsubscribeHrefOf = (html: string) => {
  const match = /<a href="([^"]*)" target="_blank">退订邮件<\/a>/.exec(html)
  if (!match) {
    throw new Error('邮件里没有退订链接')
  }
  return match[1]
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

const countOf = (text: string, part: string) => text.split(part).length - 1

describe.each(CAMPAIGN_TEMPLATE_IDS)('群发邮件模板 %s', (id) => {
  it.each(['A $& B', 'price $$5', 'ref $1', "tail $' and $`"])(
    '标题 %j 里的 $ 写法原样进邮件',
    (title) => {
      const { html } = renderCampaignEmail(
        id,
        { titleHtml: title, contentHtml: '<p>正文</p>' },
        UNSUBSCRIBE_PAGE
      )

      expect(html).toContain(title)
    }
  )

  it('正文原样插入, 其中的 {{email}} 之类只是普通文字', () => {
    const content = '<p>写给 {{email}} 的 {{title}}, 验证码 {{code}} $&</p>'

    const { html } = renderCampaignEmail(
      id,
      { titleHtml: '标题', contentHtml: content },
      `${UNSUBSCRIBE_PAGE}?email=someone%40example.com`
    )

    expect(countOf(html, content)).toBe(1)
    expect(html).not.toContain('写给 someone')
  })

  it('标题与正文是受信 HTML, 标签不被转义', () => {
    const { html } = renderCampaignEmail(
      id,
      { titleHtml: '<b>标题</b>', contentHtml: '<a href="/x">链接</a>' },
      UNSUBSCRIBE_PAGE
    )

    expect(html).toContain('<b>标题</b>')
    expect(html).toContain('<a href="/x">链接</a>')
  })

  it('带加号的邮箱放进退订链接, 落地页读回的还是原邮箱', () => {
    const url = new URL(UNSUBSCRIBE_PAGE)
    url.searchParams.set('email', 'foo+tg@gmail.com')
    url.searchParams.set('code', '0b5d7b0c-3a51-4d4a-9a3a-0f6f2c5f7f10')

    const { html } = renderCampaignEmail(
      id,
      { titleHtml: '标题', contentHtml: '正文' },
      url.toString()
    )

    const landed = new URL(unsubscribeHrefOf(html))
    expect(landed.searchParams.get('email')).toBe('foo+tg@gmail.com')
    expect(landed.searchParams.get('code')).toBe(
      '0b5d7b0c-3a51-4d4a-9a3a-0f6f2c5f7f10'
    )
  })

  it('退订链接里的引号与尖括号出不了 href', () => {
    const hostile = `${UNSUBSCRIBE_PAGE}?x="><script>alert(1)</script>&y='`

    const { html } = renderCampaignEmail(
      id,
      { titleHtml: '标题', contentHtml: '正文' },
      hostile
    )

    expect(html).not.toContain('<script>')
    expect(unsubscribeHrefOf(html)).toBe(hostile)
  })

  it('主题只由模板决定, 不含管理员写的标题', () => {
    const first = renderCampaignEmail(
      id,
      { titleHtml: '标题甲', contentHtml: '正文' },
      UNSUBSCRIBE_PAGE
    )
    const second = renderCampaignEmail(
      id,
      { titleHtml: '标题乙', contentHtml: '正文' },
      UNSUBSCRIBE_PAGE
    )

    expect(first.subject).toBe(second.subject)
    expect(first.subject).not.toBe('')
  })
})

describe('adminSendEmailSchema', () => {
  const valid = {
    templateId: CAMPAIGN_TEMPLATE_IDS[0],
    variables: { title: '标题', content: '<p>正文</p>' }
  }

  it('放行已登记的模板, 并去掉标题与正文首尾的空白', () => {
    const result = adminSendEmailSchema.safeParse({
      ...valid,
      variables: { title: '  标题 ', content: '\n<p>正文</p>\n' }
    })

    expect(result.success && result.data.variables).toEqual({
      title: '标题',
      content: '<p>正文</p>'
    })
  })

  it.each(['', 'unknown-template', 'constructor', 'toString'])(
    '拒绝没有登记的模板 %j',
    (templateId) => {
      expect(
        adminSendEmailSchema.safeParse({ ...valid, templateId }).success
      ).toBe(false)
    }
  )

  it.each([
    ['标题为空', { title: '', content: '正文' }],
    ['标题只有空白', { title: '   ', content: '正文' }],
    ['正文为空', { title: '标题', content: '' }],
    ['正文只有空白', { title: '标题', content: ' \n ' }],
    ['缺正文', { title: '标题' }],
    [
      '标题超长',
      { title: 'a'.repeat(MAIL_CAMPAIGN_TITLE_LIMIT + 1), content: '正文' }
    ],
    [
      '正文超长',
      { title: '标题', content: 'a'.repeat(MAIL_CAMPAIGN_CONTENT_LIMIT + 1) }
    ]
  ])('拒绝%s', (_, variables) => {
    expect(
      adminSendEmailSchema.safeParse({ ...valid, variables }).success
    ).toBe(false)
  })

  it.each([
    ['标题带 NUL', { title: '标\u0000题', content: '正文' }],
    ['正文带 NUL', { title: '标题', content: '<p>正\u0000文</p>' }],
    ['正文带孤立代理', { title: '标题', content: '<p>\ud83d</p>' }]
  ])('拒绝%s (写不进库的字符不该变成 500)', (_, variables) => {
    expect(
      adminSendEmailSchema.safeParse({ ...valid, variables }).success
    ).toBe(false)
  })

  it('长度恰好到上限的标题与正文放行', () => {
    expect(
      adminSendEmailSchema.safeParse({
        ...valid,
        variables: {
          title: 'a'.repeat(MAIL_CAMPAIGN_TITLE_LIMIT),
          content: 'a'.repeat(MAIL_CAMPAIGN_CONTENT_LIMIT)
        }
      }).success
    ).toBe(true)
  })
})
