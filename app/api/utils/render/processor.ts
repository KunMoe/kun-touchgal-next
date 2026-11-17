import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { remarkKunDirectives } from '~/utils/markdown/kunDialect'
import { KUN_MARKDOWN_PROFILES } from './profiles'
import { rehypeKunImageLoading } from './rehypeKunImageLoading'
import { remarkKunExternalLinks } from './remarkKunExternalLinks'
import { remarkKunLink } from './remarkKunLink'
import { remarkKunVideo } from './remarkKunVideo'
import { remarkKunWrapImage } from './remarkKunWrapImage'
import type { Processor } from 'unified'
import type { Parent } from 'unist'
import type { KunMarkdownProfile, KunMarkdownProfileSpec } from './profiles'

// 条件装配的插件链推不出各阶段的树类型, 这里只声明到「带 children 的根节点」:
// 入口做的只是把 parse 的产物原样交还给同一个处理器
export type KunMarkdownProcessor = Processor<
  Parent,
  Parent,
  Parent,
  Parent,
  string
>

// 各 profile 的处理器只在这里组装, 阶段顺序对所有 profile 相同
const createProcessor = (
  profile: KunMarkdownProfileSpec
): KunMarkdownProcessor => {
  const processor = unified()

  // 语法
  processor.use(remarkParse).use(remarkGfm).use(remarkFrontmatter)
  if (profile.directives !== 'off') {
    processor.use(remarkKunDirectives, { mode: profile.directives })
  }

  // markdown 树上的变换
  if (profile.directives === 'render') {
    processor.use(remarkKunVideo).use(remarkKunLink)
  }

  // 转成 HTML 树。净化之前的插件看到的仍是不可信内容
  processor.use(remarkRehype).use(remarkKunExternalLinks)

  // 净化是最后一个处理不可信内容的阶段, 排在它后面的插件不得再引入用户可控的属性
  processor.use(rehypeSanitize, profile.schema)

  processor.use(rehypeKunImageLoading)
  if (profile.wrapScreenshots) {
    processor.use(remarkKunWrapImage)
  }

  processor.use(rehypeStringify)

  return processor.freeze() as unknown as KunMarkdownProcessor
}

const PROCESSORS: Record<KunMarkdownProfile, KunMarkdownProcessor> = {
  comment: createProcessor(KUN_MARKDOWN_PROFILES.comment),
  note: createProcessor(KUN_MARKDOWN_PROFILES.note),
  introduction: createProcessor(KUN_MARKDOWN_PROFILES.introduction)
}

export const getKunMarkdownProcessor = (profile: KunMarkdownProfile) =>
  PROCESSORS[profile]
