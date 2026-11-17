import { getKunMarkdownProcessor } from './processor'
import { KUN_MARKDOWN_PROFILES } from './profiles'

export const COMMENT_HTML_VERSION = KUN_MARKDOWN_PROFILES.comment.version

export const markdownCommentProcessor = getKunMarkdownProcessor('comment')
