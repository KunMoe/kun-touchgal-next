import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { buildCustomRoute } from 'next/dist/lib/build-custom-route'
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server'
import { kunRscCacheHeaders } from '~/config/rsc-cache-headers'
import { kunSecurityHeaders } from '~/config/security-headers'

// next.config.ts 引入 dotenv-check 带副作用, 不能在测试里导入: 下面先静态读出它的 nextConfig
// 字面量, 钉住 headers() 恰好是两组规则的拼接; 再按同样的写法组合, 用 Next 自己的匹配实现断言
const nextConfigFields = () => {
  const file = fileURLToPath(new URL('../../next.config.ts', import.meta.url))
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const fields = new Map<string, ts.Expression>()
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === 'nextConfig' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property)) {
          fields.set(property.name.getText(source), property.initializer)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return fields
}

describe('next.config.ts 的接线', () => {
  const fields = nextConfigFields()

  it('headers() 只返回 RSC 缓存规则与安全头两组, 不另加规则', () => {
    const headers = fields.get('headers')
    const body = headers && ts.isArrowFunction(headers) ? headers.body : null
    expect(body && ts.isArrayLiteralExpression(body)).toBe(true)
    expect(
      (body as ts.ArrayLiteralExpression).elements.map((element) =>
        element.getText()
      )
    ).toEqual(['...kunRscCacheHeaders', '...kunSecurityHeaders'])
  })

  it('不发 X-Powered-By', () => {
    expect(fields.get('poweredByHeader')?.kind).toBe(ts.SyntaxKind.FalseKeyword)
  })

  // 截断的文案 (lib/http/readBody.ts) 按这个常量说上限, 两者必须是同一个数
  it('proxy 克隆请求体的上限取 constants/bodyBudget.ts 的常量', () => {
    const experimental = fields.get('experimental')
    const limit =
      experimental && ts.isObjectLiteralExpression(experimental)
        ? experimental.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) &&
              property.name.getText() === 'proxyClientMaxBodySize'
          )
        : undefined
    expect(
      limit && ts.isPropertyAssignment(limit) && limit.initializer.getText()
    ).toBe('KUN_PROXY_BODY_CLONE_LIMIT')
  })
})

const nextConfig = {
  headers: async () => [...kunRscCacheHeaders, ...kunSecurityHeaders]
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), browsing-topics=()'
}

const responseHeadersOf = async (
  url: string,
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {}
) => {
  const res = await unstable_getResponseFromNextConfig({
    url,
    nextConfig,
    headers,
    cookies
  })
  // content-type 来自测试工具自己构造的空 Response, 不是规则下发的
  return Object.fromEntries(
    [...res.headers.entries()].filter(([key]) => key !== 'content-type')
  )
}

describe('应用自证的响应安全头', () => {
  it('一条覆盖全站的规则, 四个头的取值', () => {
    expect(kunSecurityHeaders).toHaveLength(1)
    const [rule] = kunSecurityHeaders
    expect(
      Object.fromEntries(
        rule.headers.map(({ key, value }) => [key.toLowerCase(), value])
      )
    ).toEqual(SECURITY_HEADERS)
    expect(rule.has).toBeUndefined()
    expect(rule.missing).toBeUndefined()
  })

  // Cache-Control 只归 rsc-cache-headers.ts (R2-C3); CSP 放进 headers() 会盖掉 route handler
  // 自设的同名头, 也让 oidc-provider 的 form_post 脚本哈希追加失效; HSTS 归边缘; COOP 会切断
  // 依赖方弹窗登录要用的 opener
  it.each([
    'cache-control',
    'content-security-policy',
    'strict-transport-security',
    'cross-origin-opener-policy'
  ])('不写 %s', (name) => {
    for (const rule of kunSecurityHeaders) {
      expect(rule.headers.map(({ key }) => key.toLowerCase())).not.toContain(
        name
      )
    }
  })

  it.each([
    '/',
    '/galgame',
    '/f5511f9f/resource/17049',
    '/doc/notice/faq',
    '/oidc/auth',
    '/oidc/.well-known/openid-configuration',
    '/api/user/setting/email/revert',
    '/_next/static/chunks/main.js',
    '/cap/cap_wasm_bg.wasm'
  ])('%s 命中', (path) => {
    const [rule] = kunSecurityHeaders
    expect(new RegExp(buildCustomRoute('header', rule).regex).test(path)).toBe(
      true
    )
  })
})

describe('与 kunRscCacheHeaders 组合', () => {
  it('游客 RSC 请求: 安全头之外, 缓存规则原样生效', async () => {
    expect(await responseHeadersOf('/galgame', { rsc: '1' })).toEqual({
      ...SECURITY_HEADERS,
      'cache-control': 'private, no-cache'
    })
  })

  it('登录态 RSC 与 HTML 请求: 只有安全头, 不带规则里的 Cache-Control', async () => {
    expect(
      await responseHeadersOf(
        '/galgame',
        { rsc: '1' },
        { 'kun-galgame-patch-moe-token': 't' }
      )
    ).toEqual(SECURITY_HEADERS)
    expect(await responseHeadersOf('/galgame')).toEqual(SECURITY_HEADERS)
  })

  it('/doc 的 RSC 请求不进缓存规则, 安全头照样下发', async () => {
    expect(await responseHeadersOf('/doc/notice/faq', { rsc: '1' })).toEqual(
      SECURITY_HEADERS
    )
  })
})
