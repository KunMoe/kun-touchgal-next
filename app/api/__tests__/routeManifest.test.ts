import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// 全站 Route Handler 的访问清单 (T10)。kun/inv-route-01 要求每个导出的 HTTP 方法都由
// kunRoute.<method>({ ... }) 定义、访问相关的字段都是字面量, 所以这里静态读源码就能拿到
// 全部声明, 不必 import 路由模块 (那会连带加载 prisma、redis 与各家 SDK)。
// 清单本身写进 __snapshots__/routeManifest.txt: 任何访问级别、能力、遗留文案的变化都会出现在
// 那个文件的 diff 里, 必须由评审者看过再更新 (vitest -u)

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

interface RouteDecl {
  file: string
  path: string
  exportName: string
  method: string | null
  auth: string | null
  capability: string | null
  order: string | null
  csrf: string | null
  form: boolean
  legacyDeny: Record<string, string>
}

const literalText = (node: ts.Expression): string | null => {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return 'true'
  }
  return null
}

const readDef = (object: ts.ObjectLiteralExpression) => {
  const fields = new Map<string, ts.Expression>()
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      fields.set(property.name.text, property.initializer)
    }
  }
  const text = (key: string) => {
    const value = fields.get(key)
    return value ? literalText(value) : null
  }
  const legacyDeny: Record<string, string> = {}
  const deny = fields.get('legacyDeny')
  if (deny && ts.isObjectLiteralExpression(deny)) {
    for (const property of deny.properties) {
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
        legacyDeny[property.name.text] =
          literalText(property.initializer) ?? '<非字面量>'
      }
    }
  }
  return {
    auth: text('auth'),
    capability: text('capability'),
    order: text('order'),
    csrf: text('csrf'),
    form: text('form') === 'true',
    legacyDeny
  }
}

const routePathOf = (file: string) =>
  file.replace(/^app/, '').replace(/\/route\.ts$/, '') || '/'

const collectRoutes = () => {
  const files = globSync('app/**/route.ts', { cwd: repoRoot }).sort()
  const decls: RouteDecl[] = []
  const unmigrated: string[] = []
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(`${repoRoot}/${file}`, 'utf-8'),
      ts.ScriptTarget.Latest,
      true
    )
    let usesKunRoute = false
    let exportsHandler = false
    for (const statement of source.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        !statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        )
      ) {
        if (
          ts.isFunctionDeclaration(statement) &&
          statement.name &&
          /^(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)$/.test(statement.name.text)
        ) {
          exportsHandler = true
        }
        continue
      }
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          !/^(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)$/.test(
            declaration.name.text
          )
        ) {
          continue
        }
        exportsHandler = true
        const init = declaration.initializer
        if (
          !init ||
          !ts.isCallExpression(init) ||
          !ts.isPropertyAccessExpression(init.expression) ||
          !ts.isIdentifier(init.expression.expression) ||
          init.expression.expression.text !== 'kunRoute'
        ) {
          continue
        }
        usesKunRoute = true
        const [def] = init.arguments
        decls.push({
          file,
          path: routePathOf(file),
          exportName: declaration.name.text,
          method: init.expression.name.text,
          ...(def && ts.isObjectLiteralExpression(def)
            ? readDef(def)
            : {
                auth: null,
                capability: null,
                order: null,
                csrf: null,
                form: false,
                legacyDeny: {}
              })
        })
      }
    }
    if (exportsHandler && !usesKunRoute) {
      unmigrated.push(file)
    }
  }
  return { files, decls, unmigrated }
}

const { files, decls, unmigrated } = collectRoutes()

const keyOf = (decl: RouteDecl) => `${decl.exportName} ${decl.path}`

// 对游客开放 (public: 不读会话; optional: 读会话但游客也放行) 的入口, 逐条写明理由。
// 新增或放宽一个入口必须在这里登记; 「待裁定」的条目由站长裁定后改一个字面量
const GUEST_ACCESS: Record<string, string> = {
  'POST /api/auth/captcha/challenge': '人机验证挑战签发, 登录前使用',
  'POST /api/auth/captcha/redeem': '人机验证兑换, 登录前使用',
  'GET /api/auth/check-temp-token': '认的是 2FA 临时令牌, 登录第二步使用',
  'POST /api/auth/email-notice/disable': '凭邮件里的验证码退订',
  'POST /api/auth/login': '登录',
  'POST /api/auth/register': '注册',
  'POST /api/auth/send-register-code': '注册验证码',
  'POST /api/auth/verify-2fa': '认的是 2FA 临时令牌, 登录第二步',
  'POST /api/forgot/request': '找回密码',
  'POST /api/forgot/reset': '找回密码 (凭邮件里的重置令牌)',
  'GET /api/apply/status': '创作者申请状态, 游客回未申请',
  'GET /api/company': '会社详情, 会社页对游客公开',
  'GET /api/company/all': '会社列表, 会社页对游客公开',
  'GET /api/company/galgame': '会社下的作品列表, 按请求视角过滤',
  'POST /api/company/search': '会社搜索建议',
  'GET /api/edit/duplicate': '查重探测, 只回已存在条目的 uniqueId',
  'GET /api/galgame': '作品列表, 按请求视角过滤',
  'GET /api/home': '首页, 按请求视角过滤',
  'GET /api/home/random': '首页随机作品, 按请求视角过滤',
  'GET /api/patch': '作品详情, 按请求视角过滤; 登录者另带收藏等个人字段',
  'GET /api/patch/resource': '作品页的资源列表; 登录者看得到自己待审核的资源',
  'PUT /api/patch/resource/download': '下载计数, 游客按 IP 去重',
  'GET /api/patch/introduction': '游戏简介, 对外公开的 API (C54 裁定保留)',
  'GET /api/patch/moyu': '按 VNDB id 查资源, 对外公开的 API',
  'GET /api/resource': '资源列表, 按请求视角过滤',
  'POST /api/search': '搜索, 按请求视角过滤',
  'POST /api/search/tag': '搜索页的标签建议, 搜索页对游客公开',
  'GET /api/tag': '待裁定 X01-03: 标签详情, 标签页对游客隐藏而本接口不拦',
  'GET /api/tag/galgame':
    '待裁定 X01-03: 标签下的作品列表, 标签页对游客隐藏而本接口不拦',
  'POST /api/message': '已停用的桩, 固定回提示文案',
  'POST /api/upload/resource': '已废弃的桩, 固定回 410',
  'GET /api/user/profile/floating':
    '用户悬浮名片, 游客可见的作品页、评论区上也会弹出',
  'GET /api/user/setting/2fa/status': '游客回固定的「未启用」, 不带任何数据',
  'GET /api/user/session':
    '会话探测, 自己解析令牌以区分无效 (401) 与暂时不可用 (503)',
  'GET /api/user/setting/email/revert': '凭邮件里的一次性撤销令牌',
  'POST /api/user/setting/email/revert': '凭邮件里的一次性撤销令牌',
  'GET /oidc/[...path]': 'oidc-provider 透传, 按协议认客户端与 provider 会话',
  'POST /oidc/[...path]': 'oidc-provider 透传',
  'PUT /oidc/[...path]': 'oidc-provider 透传',
  'DELETE /oidc/[...path]': 'oidc-provider 透传',
  'PATCH /oidc/[...path]': 'oidc-provider 透传',
  'HEAD /oidc/[...path]': 'oidc-provider 透传',
  'OPTIONS /oidc/[...path]': 'oidc-provider 透传',
  'GET /oidc/interaction/[uid]/confirm': '未登录时转本站登录页',
  'POST /oidc/interaction/[uid]/confirm':
    '站点登录态与 SSO 会话不一致时以 login_required 结束授权'
}

// 前缀下的入口不得低于这里的要求; 例外逐条写理由
const PREFIX_POLICY: {
  prefix: string
  capability?: string
  except: Record<string, string>
}[] = [
  { prefix: '/api/admin/', capability: 'admin.access', except: {} },
  {
    prefix: '/api/user/setting/',
    except: {
      'GET /api/user/setting/2fa/status':
        '游客回固定的「未启用」, 不带任何数据',
      'GET /api/user/setting/email/revert': '凭邮件里的一次性撤销令牌',
      'POST /api/user/setting/email/revert': '凭邮件里的一次性撤销令牌'
    }
  },
  {
    prefix: '/api/message/',
    except: {}
  },
  {
    prefix: '/api/upload/',
    except: { 'POST /api/upload/resource': '已废弃的桩, 固定回 410' }
  }
]

// legacyDeny 是迁移期保留的漂移文案与状态码, 只减不增: 统一文案时同步调低
const LEGACY_DENY_BUDGET = 13

const formatDecl = (decl: RouteDecl) =>
  [
    keyOf(decl).padEnd(56),
    decl.auth,
    decl.capability && `capability=${decl.capability}`,
    decl.order && `order=${decl.order}`,
    decl.csrf && `csrf=${decl.csrf}`,
    decl.form && 'form',
    ...Object.entries(decl.legacyDeny).map(
      ([key, value]) => `legacyDeny.${key}=${value}`
    )
  ]
    .filter(Boolean)
    .join(' ')

describe('Route Handler 访问清单', () => {
  it('读到了全部 route 文件', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(decls.length).toBeGreaterThan(0)
  })

  it('每个导出 HTTP 方法的 route 文件都由 kunRoute 定义', () => {
    expect(unmigrated).toEqual([])
  })

  it('导出名与 kunRoute 的方法一致, 访问字段都是字面量', () => {
    for (const decl of decls) {
      expect(decl.method?.toUpperCase(), keyOf(decl)).toBe(decl.exportName)
      expect(['public', 'optional', 'user'], keyOf(decl)).toContain(decl.auth)
      if (decl.capability !== null) {
        expect(decl.auth, keyOf(decl)).toBe('user')
      }
    }
  })

  it('对游客开放的入口恰好是登记过理由的那些', () => {
    const open = decls
      .filter((decl) => decl.auth === 'public' || decl.auth === 'optional')
      .map(keyOf)
      .sort()
    expect(open).toEqual(Object.keys(GUEST_ACCESS).sort())
  })

  it.each(PREFIX_POLICY)('$prefix 下的入口不低于前缀要求', (policy) => {
    const violations = decls
      .filter(
        (decl) =>
          decl.path.startsWith(policy.prefix) && !(keyOf(decl) in policy.except)
      )
      .filter(
        (decl) =>
          decl.auth !== 'user' ||
          (policy.capability !== undefined &&
            decl.capability !== policy.capability)
      )
      .map(formatDecl)
    expect(violations).toEqual([])
    for (const key of Object.keys(policy.except)) {
      expect(decls.map(keyOf), `例外条目已不存在: ${key}`).toContain(key)
    }
  })

  // proxy 的 matcher 只把 /api/upload/* 排除在 CSRF 之外 (避免缓冲大请求体)
  it("/api/upload/* 的写方法都在 handler 里补 CSRF, 别处不声明 csrf: 'handler'", () => {
    for (const decl of decls) {
      const isUpload = decl.path.startsWith('/api/upload/')
      const isWrite = decl.exportName !== 'GET' && decl.exportName !== 'HEAD'
      expect(decl.csrf, keyOf(decl)).toBe(
        isUpload && isWrite ? 'handler' : null
      )
    }
  })

  it('legacyDeny 只减不增', () => {
    const count = decls.filter(
      (decl) => Object.keys(decl.legacyDeny).length > 0
    ).length
    expect(count).toBeLessThanOrEqual(LEGACY_DENY_BUDGET)
  })

  it('清单快照 (改访问声明须同步更新并经评审)', async () => {
    await expect(`${decls.map(formatDecl).join('\n')}\n`).toMatchFileSnapshot(
      './__snapshots__/routeManifest.txt'
    )
  })
})
