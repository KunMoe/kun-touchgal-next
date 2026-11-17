import { describe, expect, it } from 'vitest'
import { kunMarkdownCorpus } from '~/app/api/utils/render/__tests__/fixtures/markdownCorpus'
import { renderKunMarkdown } from '~/app/api/utils/render/renderKunMarkdown'
import { kunHtmlToText } from '~/server/content/text'
import { markdownToPreviewHtml } from '~/utils/markdownPreview'

// 评论编辑器的预览是手写的第二套渲染器 (utils/markdownPreview.ts), 与发布端在语法
// 细节上的出入已有裁定, 不在这里比。这里只守一条: 不含任何 markdown 语法的纯文字,
// 预览里看到什么, 发布之后就是什么
const plainText = kunMarkdownCorpus.filter((entry) =>
  entry.tags.includes('plain')
)

describe('评论预览与发布结果在纯文字上一致', () => {
  it.each(plainText.map((entry) => [entry.id, entry] as const))(
    '%s',
    async (_id, entry) => {
      const published = await renderKunMarkdown('comment', entry.markdown, {
        cache: false
      })

      const same =
        kunHtmlToText(markdownToPreviewHtml(entry.markdown)) ===
        kunHtmlToText(published.html)

      // 发布端吞字的现状在语料里标成了 knownBad, 修好之前两边必然不同
      expect(same).toBe(entry.knownBad?.want?.comment === undefined)
    }
  )
})
