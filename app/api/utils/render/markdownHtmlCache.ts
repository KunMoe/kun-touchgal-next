import { createHash } from 'crypto'
import { MARKDOWN_HTML_CACHE_MAX_HTML_BYTES } from '~/config/cache'
import type { KunMarkdownProfile } from './profiles'

// markdown 渲染结果的 Redis 缓存: 只管读写、同键并发合并、超时与熔断。渲染预算、
// 失败语义与品牌都在 renderKunMarkdown.ts, 这里不解释 reason 的取值

// reason 存在表示这条是失败后的降级输出 (负缓存)
export interface MarkdownHtmlCacheEntry {
  html: string
  reason?: string
}

const MARKDOWN_HTML_CACHE_KEY = 'markdown:html'
// v4: 缓存值由裸 HTML 字符串改为 JSON { html, reason? }
const MARKDOWN_HTML_CACHE_VERSION = 'v4'
const MARKDOWN_HTML_CACHE_TIMEOUT_MS = 200
const MARKDOWN_HTML_CACHE_RETRY_DELAY_MS = 30 * 1000

let markdownHtmlCacheDisabledUntil = 0

const inFlightRenders = new Map<string, Promise<unknown>>()

const isRedisConfigured = () =>
  Boolean(process.env.REDIS_HOST && process.env.REDIS_PORT)

const isMarkdownHtmlCacheAvailable = () =>
  isRedisConfigured() && Date.now() >= markdownHtmlCacheDisabledUntil

const disableMarkdownHtmlCache = () => {
  markdownHtmlCacheDisabledUntil =
    Date.now() + MARKDOWN_HTML_CACHE_RETRY_DELAY_MS
}

const isWithinByteLimit = (value: string, maxBytes: number) =>
  Buffer.byteLength(value, 'utf8') <= maxBytes

// variant 必须带上该 profile 的 HTML 策略版本: 键只按内容 hash, 策略版本递增后
// 不带版本的键会继续供出旧策略的 HTML。不带版本的裸名字过不了类型检查
export type MarkdownHtmlCacheVariant = `${KunMarkdownProfile}-v${number}`

export const getMarkdownHtmlCacheKey = (
  variant: MarkdownHtmlCacheVariant,
  markdown: string
) => {
  const hash = createHash('sha256').update(markdown).digest('hex')
  return `${MARKDOWN_HTML_CACHE_KEY}:${MARKDOWN_HTML_CACHE_VERSION}:${variant}:${hash}`
}

const withCacheTimeout = async <T>(operation: Promise<T>, fallback: T) => {
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => {
          disableMarkdownHtmlCache()
          resolve(fallback)
        }, MARKDOWN_HTML_CACHE_TIMEOUT_MS)
      })
    ])
  } catch {
    disableMarkdownHtmlCache()
    return fallback
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

const parseCacheEntry = (raw: string): MarkdownHtmlCacheEntry | null => {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const { html, reason } = value as Record<string, unknown>
    if (typeof html !== 'string') {
      return null
    }
    if (reason === undefined) {
      return { html }
    }
    return typeof reason === 'string' ? { html, reason } : null
  } catch {
    return null
  }
}

const deleteMarkdownHtmlCache = async (cacheKey: string) => {
  if (!isMarkdownHtmlCacheAvailable()) {
    return
  }

  await withCacheTimeout(
    (async () => {
      const { delKv } = await import('~/lib/redis')
      await delKv(cacheKey)
    })(),
    undefined
  )
}

export const readMarkdownHtmlCache = async (
  cacheKey: string
): Promise<MarkdownHtmlCacheEntry | null> => {
  if (!isMarkdownHtmlCacheAvailable()) {
    return null
  }

  const raw = await withCacheTimeout(
    (async () => {
      const { getKv } = await import('~/lib/redis')
      return await getKv(cacheKey)
    })(),
    null
  )
  if (raw === null) {
    return null
  }

  const entry = parseCacheEntry(raw)
  if (
    entry !== null &&
    isWithinByteLimit(entry.html, MARKDOWN_HTML_CACHE_MAX_HTML_BYTES)
  ) {
    return entry
  }

  await deleteMarkdownHtmlCache(cacheKey)
  return null
}

export const writeMarkdownHtmlCache = async (
  cacheKey: string,
  entry: MarkdownHtmlCacheEntry,
  ttlSeconds: number
) => {
  if (
    !isMarkdownHtmlCacheAvailable() ||
    !isWithinByteLimit(entry.html, MARKDOWN_HTML_CACHE_MAX_HTML_BYTES)
  ) {
    return
  }

  await withCacheTimeout(
    (async () => {
      const { setKv } = await import('~/lib/redis')
      await setKv(cacheKey, JSON.stringify(entry), ttlSeconds)
    })(),
    undefined
  )
}

// 同一进程内同键的并发渲染合并成一次
export const coalesceMarkdownRender = async <T>(
  cacheKey: string,
  task: () => Promise<T>
): Promise<T> => {
  const existing = inFlightRenders.get(cacheKey)
  if (existing) {
    return existing as Promise<T>
  }

  const pending = task()
  inFlightRenders.set(cacheKey, pending)

  try {
    return await pending
  } finally {
    inFlightRenders.delete(cacheKey)
  }
}
