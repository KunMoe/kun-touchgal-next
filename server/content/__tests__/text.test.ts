import { beforeAll, describe, expect, it, vi } from 'vitest'
import { renderCommentHtml } from '~/app/api/utils/render/markdownToHtmlComment'
import { markdownToHtmlExtend } from '~/app/api/utils/render/markdownToHtmlExtend'
import { kunExcerpt, kunHtmlToText, kunRawExcerpt } from '../text'

// 输入一律取真实渲染管线的产物: 投影的对象是读者实际拿到的 HTML。
// 关掉 Redis 配置让介绍管线不走缓存, 测试不触网
beforeAll(() => {
  vi.stubEnv('REDIS_HOST', '')
  vi.stubEnv('REDIS_PORT', '')
})

const introduction = markdownToHtmlExtend
const comment = renderCommentHtml

describe('kunHtmlToText display: 给人看的描述、预览与摘要', () => {
  it('拉丁字母标题不转大写', async () => {
    const html = await introduction(
      '## Summer Pockets REFLECTION BLUE\n\n夏日的鸟白岛'
    )

    expect(kunHtmlToText(html)).toBe(
      'Summer Pockets REFLECTION BLUE 夏日的鸟白岛'
    )
  })

  it('链接只留文字, 不追加 [href]', async () => {
    const html = await introduction(
      '[官网](https://key.example/summer/) 现已开放'
    )

    expect(kunHtmlToText(html)).toBe('官网 现已开放')
  })

  it('自动链接的地址本身就是可见文字, 只出现一次', async () => {
    const html = await introduction('官网 https://key.example/summer/ 现已开放')

    expect(kunHtmlToText(html)).toBe(
      '官网 https://key.example/summer/ 现已开放'
    )
  })

  it('图片不进文本', async () => {
    const html = await introduction(
      '![封面](https://cdn.example.com/cover.webp)\n\n正文第二段'
    )

    expect(kunHtmlToText(html)).toBe('正文第二段')
  })

  it('外链卡片与视频占位不进文本', async () => {
    const html = await introduction(
      '::kun-link{href="https://pan.example.com/s/abc" text="网盘下载"}\n\n这是游戏介绍正文。\n\n::kun-video{src="https://cdn.example.com/pv.mp4"}\n\n宣传片之后的正文。'
    )

    expect(kunHtmlToText(html)).toBe('这是游戏介绍正文。 宣传片之后的正文。')
  })

  it('表头不转大写, 单元格以空格相连', async () => {
    const html = await introduction(
      '| 项目 | Value |\n| --- | --- |\n| 平台 | Windows |\n\n表后正文'
    )

    expect(kunHtmlToText(html)).toBe('项目 Value 平台 Windows 表后正文')
  })

  it('折叠段落与换行之间的空白', async () => {
    const html = await comment('第一段\n\n第二段\n第二段续行\n\n- 列表项')

    expect(kunHtmlToText(html)).toBe('第一段 第二段 第二段续行 * 列表项')
  })

  it('snake_case 与行内代码里的尖括号原样保留', async () => {
    const html = await comment('变量 my_var_name 用 `Map<string, number>` 存')

    expect(kunHtmlToText(html)).toBe(
      '变量 my_var_name 用 Map<string, number> 存'
    )
  })

  it('默认是 display 模式', async () => {
    const html = await comment('[官网](https://key.example/)')

    expect(kunHtmlToText(html)).toBe(kunHtmlToText(html, 'display'))
  })
})

describe('kunHtmlToText audit: 给审核看, 读者点得到的地址都保留', () => {
  it('链接保留目标地址', async () => {
    const html = await comment('[官网](https://evil.example/ref) 现已开放')

    expect(kunHtmlToText(html, 'audit')).toBe(
      '官网 [https://evil.example/ref] 现已开放'
    )
  })

  it('地址与文字相同时不重复输出', async () => {
    const html = await comment('加群 <https://t.me/joinchat/XXXX> 领资源')

    expect(kunHtmlToText(html, 'audit')).toBe(
      '加群 https://t.me/joinchat/XXXX 领资源'
    )
  })

  it('引用式链接定义里的地址渲染为活链接, 投影里可见', async () => {
    const html = await comment('参考 [1]\n\n[1]: <https://evil.example/ref>')

    expect(kunHtmlToText(html, 'audit')).toBe(
      '参考 1 [https://evil.example/ref]'
    )
  })

  it('图片输出地址', async () => {
    const html = await comment('![二维码](https://cdn.example.com/qr.png)')

    expect(kunHtmlToText(html, 'audit')).toBe(
      '[图片 https://cdn.example.com/qr.png]'
    )
  })

  it('外链卡片保留文字与地址, 视频输出地址', async () => {
    const html = await introduction(
      '::kun-link{href="https://pan.example.com/s/abc" text="网盘下载"}\n\n::kun-video{src="https://cdn.example.com/pv.mp4"}'
    )
    const text = kunHtmlToText(html, 'audit')

    expect(text).toContain('网盘下载')
    expect(text).toContain('https://pan.example.com/s/abc')
    expect(text).toContain('[视频 https://cdn.example.com/pv.mp4]')
  })

  it('行内标记拆开的数字在读者眼里是连续的, 投影里也连续', async () => {
    const html = await comment('加群 98**76**54321')

    expect(kunHtmlToText(html, 'audit')).toBe('加群 987654321')
  })

  // 这些内容渲染后不可见, 但原文会出现在通知与个人主页里 —— 所以审核不能只看投影
  it.each([
    ['容器指令', ':::note\n加群987654321\n:::'],
    ['HTML 块', '<div>\n加群987654321\n</div>'],
    ['HTML 注释', '<!-- 加群 987654321 -->']
  ])('评论里的%s渲染为空, 投影也为空', async (_name, markdown) => {
    expect(kunHtmlToText(await comment(markdown), 'audit')).toBe('')
  })
})

describe('kunExcerpt / kunRawExcerpt', () => {
  it('按码点截断, 不劈开 emoji', () => {
    const excerpt = kunExcerpt('😀'.repeat(5), 3)

    expect(excerpt).toBe('😀😀😀')
    expect(excerpt.isWellFormed()).toBe(true)
  })

  it('原文摘要只折叠空白并截断, 不重新解释 markdown 语法', () => {
    expect(
      kunRawExcerpt('  **粗体**\n\n<https://a.example> `code`  ', 100)
    ).toBe('**粗体** <https://a.example> `code`')
    expect(kunRawExcerpt('一二三四五六', 4)).toBe('一二三四')
  })
})
