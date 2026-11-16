import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import remarkDirective from 'remark-directive'
import { unified } from 'unified'
import { remarkKunVideo } from './remarkKunVideo'
import { remarkKunLink } from './remarkKunLink'
import { remarkKunExternalLinks } from './remarkKunExternalLinks'
import { remarkKunWrapImage } from './remarkKunWrapImage'
import { renderMarkdownHtmlWithCache } from './markdownHtmlCache'
import { markdownExtendSanitizeSchema } from './sanitizeSchema'
import { rehypeKunImageLoading } from './rehypeKunImageLoading'
import { PATCH_INTRODUCTION_HTML_VERSION } from './htmlVersion'

const markdownExtendProcessor = unified()
  .use(remarkParse)
  .use(remarkDirective)
  .use(remarkKunVideo)
  .use(remarkKunLink)
  .use(remarkRehype)
  .use(remarkKunExternalLinks)
  .use(rehypeSanitize, markdownExtendSanitizeSchema)
  .use(remarkFrontmatter)
  .use(remarkGfm)
  .use(rehypeKunImageLoading)
  .use(remarkKunWrapImage)
  .use(rehypeStringify)
  .freeze()

export const markdownToHtmlExtend = async (markdown: string) => {
  return renderMarkdownHtmlWithCache(
    `extend-v${PATCH_INTRODUCTION_HTML_VERSION}`,
    markdown,
    async () => {
      const htmlVFile = await markdownExtendProcessor.process(markdown)

      return String(htmlVFile)
    }
  )
}
