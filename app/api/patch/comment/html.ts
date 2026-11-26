import { prisma } from '~/prisma/index'
import { kunLog } from '~/lib/log.server'
import { KUN_MARKDOWN_PROFILES } from '~/app/api/utils/render/profiles'
import {
  renderKunMarkdown,
  renderKunMarkdownForWrite
} from '~/app/api/utils/render/renderKunMarkdown'
import type { KunSafeHtml } from '~/types/content'

const COMMENT_HTML_VERSION = KUN_MARKDOWN_PROFILES.comment.version

// 评论正文与它的派生 HTML: content_html / content_html_version 由 content 渲染而来,
// 三列的读、写、自愈都收在这里。本文件只依赖 prisma 与渲染入口, 不引评论分页缓存,
// 一次性脚本 (scripts/backfillCommentHtml.ts) 可以引入; 渲染入口默认会读写 Redis 里
// 的渲染缓存, 脚本须传 { cache: false }, 否则连上 redis 后进程退不出来

// 落库的 content_html 是渲染管线当时的产物, 版本与当前管线一致才可信。版本落后或
// 为空时返回 null, 由调用方决定是重渲染 (评论分页) 还是退回原文摘要 (各类列表)。
// 这里不渲染、不抛错, 所以列表路径不会被一条渲染失败的评论拖垮
export const readStoredCommentHtml = (row: {
  content_html: string
  content_html_version: number
}): KunSafeHtml | null =>
  row.content_html_version === COMMENT_HTML_VERSION && row.content_html
    ? (row.content_html as KunSafeHtml)
    : null

// 写入口把它整体展开进 Prisma data: 正文与派生 HTML、版本只能一起写
export type CommentContentFields = {
  content: string
  content_html: KunSafeHtml
  content_html_version: number
}

// 渲染不出来的正文在这里被拒 (返回错误消息), 调用方应在开事务前返回它。
// 所以落库的 HTML 恒为当前版本, 应用写入不再产生「空 HTML + version 0」
export const prepareCommentContent = async (
  content: string
): Promise<CommentContentFields | string> => {
  const rendered = await renderKunMarkdownForWrite('comment', content)
  if (typeof rendered === 'string') {
    return rendered
  }
  return {
    content,
    content_html: rendered.html,
    content_html_version: rendered.version
  }
}

// html 只收渲染入口的产物: 写回的内容之后会被 readStoredCommentHtml 当作已净化 HTML
export type StaleCommentHtml = { id: number; html: KunSafeHtml; updated: Date }

// 取一条评论可展示的 HTML: 落库的可信就直接用, 否则重渲染。渲染入口不会 reject,
// 所以一条渲染不出来的评论只会自己降级成纯文本。heal 非空表示这次的结果值得写回
// (版本落后, 且结果在当前版本下是确定的), 交给 persistCommentHtml
export const resolveCommentHtml = async (
  row: {
    id: number
    content: string
    content_html: string
    content_html_version: number
    updated: Date
  },
  options?: { cache?: boolean }
): Promise<{ html: KunSafeHtml; heal: StaleCommentHtml | null }> => {
  const stored = readStoredCommentHtml(row)
  if (stored !== null) {
    return { html: stored, heal: null }
  }

  const result = await renderKunMarkdown('comment', row.content, options)
  const persistable = result.ok || result.persistable
  return {
    html: result.html,
    heal:
      persistable && row.content_html_version !== COMMENT_HTML_VERSION
        ? { id: row.id, html: result.html, updated: row.updated }
        : null
  }
}

// 把重渲染的结果写回, 使版本落后的评论收敛到 content_html 快路径。评论分页的读时
// 自愈与回填脚本共用这一份。CAS 条件的两道防线:
//   1. 版本条件: 已被回填 / 其他请求更新到当前版本的行不会再次覆盖
//   2. updated 条件: 正文在读出之后被改过则不覆盖 (否则旧正文的 HTML 会被写进新正文的行)
// 逐条 autocommit 而非单个 $transaction: 各行相互独立、无原子性需求, 提交即释放行锁,
// 单条失败不牵连其他行, 下次读到时幂等重试
export const persistCommentHtml = async (
  rows: StaleCommentHtml[]
): Promise<{ written: number; skipped: number }> => {
  let written = 0
  for (const { id, html, updated } of rows) {
    try {
      const { count } = await prisma.patch_comment.updateMany({
        where: {
          id,
          content_html_version: { not: COMMENT_HTML_VERSION },
          updated
        },
        data: {
          content_html: html,
          content_html_version: COMMENT_HTML_VERSION
        }
      })
      written += count
    } catch (error) {
      kunLog('comment.html_persist_failed', {}, error)
    }
  }
  return { written, skipped: rows.length - written }
}
