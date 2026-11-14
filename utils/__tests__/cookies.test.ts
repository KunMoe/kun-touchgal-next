import { describe, expect, it } from 'vitest'
import Cookies from 'js-cookie'
import { parseCookies } from '~/utils/cookies'
import { parseBlockedTagIds } from '~/utils/blockedTag'

// store/_cookie.ts 经 Cookies.set 写入, 值由同一个 converter 编码。
// 取 converter 而非自己拼字符串, 是为了让下面的断言跟着 js-cookie 的实现走
const write = (value: string) => Cookies.converter.write(value, 'kun')

describe('parseCookies', () => {
  // 白名单漏掉的只有 %2C 和 %3B, 而分号在 cookie 值里本就不能裸奔,
  // 所以逗号是唯一既能进 JSON 又会留在编码态的字符
  it('decodes the comma escape js-cookie leaves in the value', () => {
    const written = write(JSON.stringify([1, 2, 3]))

    // 这条是白名单快照: 升级 js-cookie 后若失败, 说明本修复的前提已经变了
    expect(written).toBe('[1%2C2%2C3]')
    expect(parseCookies(`kun=${written}`).kun).toBe('[1,2,3]')
  })

  // 多标签屏蔽曾在此静默失效: JSON.parse 抛错被 catch 吃掉, 回落成空列表
  it('keeps multi-id blocked tag lists parseable end to end', () => {
    const key = 'kun-patch-setting-store|state|data|kunBlockedTagIds'
    const cookies = parseCookies(`${key}=${write(JSON.stringify([1, 2, 3]))}`)

    expect(parseBlockedTagIds(cookies[key])).toEqual([1, 2, 3])
  })

  // 服务端 token 经 encodeURIComponent 写入 (@edge-runtime/cookies stringifyCookie),
  // 而 jsonwebtoken 出的是无 padding base64url, 编码后恒等, 故不受解码放宽影响
  it('leaves the unpadded base64url auth token untouched', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjF9.ab-_9xQwErTyUiOp'

    expect(encodeURIComponent(token)).toBe(token)
    expect(parseCookies(`kun-galgame-patch-moe-token=${token}`)).toEqual({
      'kun-galgame-patch-moe-token': token
    })
  })

  // split('=') 的通用不变量; 现有 cookie 的值域都命中不到, 属防御性覆盖
  it('keeps values containing = intact', () => {
    expect(parseCookies('kun=YWJj==').kun).toBe('YWJj==')
  })

  it('parses multiple cookies and trims the surrounding space', () => {
    expect(parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' })
  })

  // 两个解码函数对畸形序列都抛 URIError, 换成 decodeURIComponent 没有改变触发面
  it('falls back to the raw value on a malformed escape', () => {
    expect(parseCookies('kun=100%').kun).toBe('100%')
    expect(parseCookies('kun=a%zz').kun).toBe('a%zz')
    expect(parseCookies('kun=%E4%B8').kun).toBe('%E4%B8')
  })

  // proxy 在 /admin /user /edit 上读 token, 一个第三方坏 cookie 不能让它 500
  it('isolates a malformed cookie from the rest of the header', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjF9.ab-_9xQwErTyUiOp'
    const cookies = parseCookies(
      `_third=100%; kun-galgame-patch-moe-token=${token}`
    )

    expect(cookies._third).toBe('100%')
    expect(cookies['kun-galgame-patch-moe-token']).toBe(token)
  })
})
