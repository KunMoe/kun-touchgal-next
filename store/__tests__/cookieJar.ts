import { vi } from 'vitest'

// 测试用的 cookie 罐: 充当 document.cookie, 记下每一次写入 (js-cookie 的 set 与 remove 都是写)。
// 带过期时间且已过期的写入按浏览器的做法删掉那个键
export const createCookieJar = (seed: Record<string, string> = {}) => {
  const jar = new Map(Object.entries(seed))
  let writes = 0

  vi.stubGlobal('document', {
    get cookie() {
      return [...jar].map(([key, value]) => `${key}=${value}`).join('; ')
    },
    set cookie(raw: string) {
      writes++
      const [pair, ...attributes] = raw.split(';').map((part) => part.trim())
      const index = pair.indexOf('=')
      const key = pair.slice(0, index)
      const expired = attributes.some(
        (attribute) =>
          /^expires=/i.test(attribute) &&
          new Date(attribute.slice('expires='.length)).getTime() < Date.now()
      )
      if (expired) {
        jar.delete(key)
      } else {
        jar.set(key, pair.slice(index + 1))
      }
    }
  })

  return {
    get writes() {
      return writes
    },
    snapshot: () => Object.fromEntries([...jar].sort()),
    get: (key: string) => jar.get(key)
  }
}
