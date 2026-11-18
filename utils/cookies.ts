// 畸形百分号序列会让 decodeURIComponent 抛 URIError。proxy 里抛一次就是
// /admin /user /edit 的 500, 而失败的 middleware 同时挡住了能清掉坏 cookie 的
// 页面, 用户无法自救; 回落原值让同一 header 里其余 cookie 照常可读
const decodeCookieValue = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// 服务端 (server/viewer 与 proxy) 经这里读 token 与分级设置, 两者的值里都没有逗号和 %。
// 解码仍与 store/_cookie.ts 的写入保持同一套 (decodeURIComponent): js-cookie 写入时不解回
// %2C, 换成 decodeURI 会让含逗号的值读不回来
export const parseCookies = (cookieString: string) => {
  const cookiesKv: { [key: string]: string } = {}
  cookieString &&
    cookieString.split(';').forEach((cookie) => {
      const parts: string[] = cookie.split('=')
      if (parts.length) {
        cookiesKv[parts.shift()!.trim()] = decodeCookieValue(parts.join('='))
      }
    })
  return cookiesKv
}
