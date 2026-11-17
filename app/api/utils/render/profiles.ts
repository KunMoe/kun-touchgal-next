import {
  markdownExtendSanitizeSchema,
  markdownSanitizeSchema
} from './sanitizeSchema'
import type { Options as RehypeSanitizeOptions } from 'rehype-sanitize'

// 服务端 markdown 的三种内容形态。新增一种形态是在这张表里加一行, 不是复制处理器

export type KunMarkdownProfile = 'comment' | 'note' | 'introduction'

export interface KunMarkdownProfileSpec {
  // 渲染策略版本, 也是该 profile 唯一的版本号: 落库 HTML 的 content_html_version、
  // 渲染缓存键、简介缓存键都只从这里取。处理器、净化策略、渲染预算, 或一次会改变输出的
  // 依赖升级, 任一变化都要递增 (profileLock.test.ts 执法)
  readonly version: number
  // off: 不解析指令; render: 渲染成播放器 / 链接卡片; drop: 解析但不显示
  readonly directives: 'off' | 'render' | 'drop'
  // 把「游戏截图」标题下的图片收进一个容器
  readonly wrapScreenshots: boolean
  readonly schema: Readonly<RehypeSanitizeOptions>
}

export const KUN_MARKDOWN_PROFILES = {
  comment: {
    version: 2,
    directives: 'drop',
    wrapScreenshots: false,
    schema: markdownSanitizeSchema
  },
  // 资源备注
  note: {
    version: 1,
    directives: 'off',
    wrapScreenshots: false,
    schema: markdownSanitizeSchema
  },
  // 游戏简介
  introduction: {
    version: 11,
    directives: 'render',
    wrapScreenshots: true,
    schema: markdownExtendSanitizeSchema
  }
} as const satisfies Record<KunMarkdownProfile, KunMarkdownProfileSpec>
