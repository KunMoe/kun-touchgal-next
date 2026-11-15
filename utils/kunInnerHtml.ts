import type { KunSafeHtml } from '~/types/content'

// dangerouslySetInnerHTML 的唯一合法取值: React 的 __html 类型是 string | TrustedHTML,
// 而 TrustedHTML 是空接口, 结构上什么都收; 经这层包装才能把入参收窄到已净化的 HTML
export const kunInnerHtml = (html: KunSafeHtml) => ({ __html: html })
