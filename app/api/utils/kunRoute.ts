import { NextResponse } from 'next/server'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import {
  kunParseDeleteQuery,
  kunParseFormData,
  kunParseGetQuery,
  kunParsePostBody,
  kunParsePutBody
} from '~/app/api/utils/parseQuery'
import { can, KUN_CAPABILITY } from '~/constants/permission'
import { KUN_ROLE_LABEL } from '~/constants/role'
import { kunViolationCodeOf } from '~/server/db/violations'
import { kunAbuseGate } from '~/server/abuse/budget'
import type * as z from 'zod'
import type { NextRequest } from 'next/server'
import type { KunCapability } from '~/constants/permission'
import type { KunViolationCode } from '~/server/db/violations'
import type { KunAbusePolicyName } from '~/server/abuse/policies'

// Route Handler 的入口构造器 (T10): 每个导出的 HTTP 方法在定义处声明访问级别, auth 必填,
// kun/inv-route-01 要求它是字面量, app/api/__tests__/routeManifest.test.ts 把全部声明列成清单。
// 解析、身份与能力门、序列化在这里各只有一份; 对象级授权 (作者或管理员、会话成员、发布资格)
// 仍在 service 里。这是高阶函数, 不是依赖注入
//
// 默认先解析后鉴权 (#52): 校验失败的请求不碰会话。只有 #60 裁定的表单用 order: 'auth-first'
// abuse 声明的频率预算 (server/abuse/policies.ts) 排在解析与鉴权之后、handler 之前: 校验失败、
// 没登录的请求不计数
//
// 测试兼容 (路由测试按模块 mock 依赖, 改这个文件时要守住):
// - next/server 只用 NextResponse.json: 多数测试把它 mock 成只有这一个导出
// - 解析函数只在用到的分支里引用: 测试 mock parseQuery 时只给本路由用的那一个, 访问工厂里
//   没有的导出会抛错, 所以不能在模块顶层建函数表
// - 除解析与鉴权 helper 外不读 req; 路由的第二个参数允许缺省

// public: 不读会话; optional: 读会话, 游客也放行; user: 必须登录, 可再要求一项能力
export type KunRouteAuth = 'public' | 'optional' | 'user'

export type KunRoutePayload = NonNullable<
  Awaited<ReturnType<typeof verifyHeaderCookie>>
>

type KunRouteActor<A extends KunRouteAuth> = A extends 'user'
  ? KunRoutePayload
  : A extends 'optional'
    ? KunRoutePayload | null
    : undefined

// 仓库里的动态段都是单段 ([id]、[uid]); 透传的 OIDC 通配段不声明 params
export type KunRouteParams = Record<string, string>

// 输入一定是对象: 请求体解析失败时 kunParse*Body 交给 schema 的是 null, 顶层可空的
// schema 会把坏请求当成合法输入放行 (parse-body-json-catch-null), 所以类型上就不收
type KunRouteSchema = z.ZodType<unknown, Record<string, unknown>>

type KunRouteInput<S> = S extends z.ZodType ? z.infer<S> : undefined

// string 照旧以 200 + 字符串返回 (业务错误); Response 原样透传 (写 cookie、410 桩、遗留的 401 等)
type KunRouteResult = string | object

// 迁移前就有的拒绝文案与状态码原样保留, 统一文案和状态码另行裁定。只减不增 (清单测试计数)
interface KunRouteLegacyDeny {
  unauthenticated?: string
  unauthenticatedStatus?: 401
  forbidden?: string
}

export interface KunRouteContext<A extends KunRouteAuth, I, P> {
  req: NextRequest
  input: I
  params: P
  actor: KunRouteActor<A>
}

interface KunRouteDefBase<A extends KunRouteAuth, I, P> {
  auth: A
  // 只给 user: 登录之后再要求的能力 (constants/permission.ts)
  capability?: A extends 'user' ? KunCapability : never
  // 动态段, 最先解析; 返回 string 即校验失败的消息
  params?: (raw: KunRouteParams) => P | string
  // 只给 user: 按账号 (及全站) 计的频率预算, 超限时回策略的文案。要按成本计费 (提及按人数)
  // 或只在部分分支计数 (moyu 只在缓存未命中时) 的, 在属主处调 reserveAbuseBudget
  abuse?: A extends 'user' ? readonly KunAbusePolicyName[] : never
  legacyDeny?: A extends 'user' ? KunRouteLegacyDeny : never
  handler: (
    ctx: KunRouteContext<A, I, P>
  ) => Promise<KunRouteResult> | KunRouteResult
}

interface KunRouteInputDef<
  A extends KunRouteAuth,
  S,
  P
> extends KunRouteDefBase<A, KunRouteInput<S>, P> {
  // get / delete 读 query, post / put 读 JSON 请求体; 不写 input 的入口在 handler 里自己解析
  input?: S
  order?: 'auth-first'
}

// 请求体的字节预算 (lib/http/readBody.ts, 取值在 constants/bodyBudget.ts), 只管 input 的解析。
// JSON 不写时取 KUN_BODY_BUDGET.json; multipart (form, 经 kunParseFormData) 没有默认值, 不写编译不过
type KunRouteBodyBudget =
  { form?: undefined; maxBytes?: number } | { form: true; maxBytes: number }

type KunRouteBodyDef<A extends KunRouteAuth, S, P> = KunRouteInputDef<A, S, P> &
  KunRouteBodyBudget

// 第二个参数按 Next 的路由类型校验放宽为 unknown (通配段的 params 是 string[])
export type KunRouteHandler = (
  req: NextRequest,
  context?: { params?: Promise<unknown> }
) => Promise<Response>

type KunRouteMethod =
  'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'

type KunRouteAnyDef = KunRouteDefBase<KunRouteAuth, unknown, unknown> & {
  input?: KunRouteSchema
  order?: 'auth-first'
} & KunRouteBodyBudget

const KUN_UNAUTHENTICATED = '用户未登录'

// 能力表只回答是否 (表里不放文案); 拒绝文案按这项能力的最低角色给出
const forbiddenMessage = (capability: KunCapability) =>
  `本页面仅${KUN_ROLE_LABEL[KUN_CAPABILITY[capability]]}可访问`

const parseInput = (
  method: KunRouteMethod,
  req: NextRequest,
  def: KunRouteAnyDef
): unknown => {
  const schema = def.input
  if (!schema) {
    return undefined
  }
  if (def.form) {
    return kunParseFormData(req, schema, { maxBytes: def.maxBytes })
  }
  switch (method) {
    case 'GET':
      return kunParseGetQuery(req, schema)
    case 'DELETE':
      return kunParseDeleteQuery(req, schema)
    case 'POST':
      return kunParsePostBody(req, schema, { maxBytes: def.maxBytes })
    case 'PUT':
      return kunParsePutBody(req, schema, { maxBytes: def.maxBytes })
    default:
      return undefined
  }
}

type KunRouteAuthResult =
  | { ok: true; actor: KunRoutePayload | null | undefined }
  | { ok: false; response: Response }

const authorize = async (
  req: NextRequest,
  def: KunRouteAnyDef
): Promise<KunRouteAuthResult> => {
  if (def.auth === 'public') {
    return { ok: true, actor: undefined }
  }

  const payload = await verifyHeaderCookie(req)
  if (def.auth === 'optional') {
    return { ok: true, actor: payload }
  }
  if (!payload) {
    const deny = def.legacyDeny
    return {
      ok: false,
      response: deny?.unauthenticatedStatus
        ? NextResponse.json(deny.unauthenticated ?? KUN_UNAUTHENTICATED, {
            status: deny.unauthenticatedStatus
          })
        : NextResponse.json(deny?.unauthenticated ?? KUN_UNAUTHENTICATED)
    }
  }
  if (def.capability && !can(payload, def.capability)) {
    return {
      ok: false,
      response: NextResponse.json(
        def.legacyDeny?.forbidden ?? forbiddenMessage(def.capability)
      )
    }
  }
  return { ok: true, actor: payload }
}

// 违例兜底: handler 里漏翻的三类 Prisma 已知违例 (外键、唯一、目标行不存在) 多半是并发删改,
// 原样冒出时 Next 回空体 500, kunFetch 抛错, 没写 finally 的提交按钮会一直转圈。这里只认这三个
// code (不读 meta, #57), 回一句通用文案并记 warn; 精确到操作的文案仍由 service 负责
// (事务里用 kunTx 的 violations 声明, 事务外自己 catch), 先于这里生效。其余异常
// (含 P2034、P2020 这类编程或并发信号) 记一条带上下文的 error 后原样重抛
const KUN_VIOLATION_MESSAGE: Readonly<Record<KunViolationCode, string>> = {
  P2002: '数据已存在或已被修改, 请刷新页面后重试',
  P2003: '相关内容不存在或已被删除, 请刷新页面后重试',
  P2025: '相关内容不存在或已被删除, 请刷新页面后重试'
}

const pathOf = (req: NextRequest) => {
  try {
    return new URL(req.url).pathname
  } catch {
    return String(req.url)
  }
}

const runHandler = async (
  method: KunRouteMethod,
  req: NextRequest,
  def: KunRouteAnyDef,
  ctx: KunRouteContext<KunRouteAuth, unknown, unknown>
): Promise<KunRouteResult> => {
  try {
    return await def.handler(ctx as never)
  } catch (error) {
    const context = { method, path: pathOf(req), uid: ctx.actor?.uid }
    const code = kunViolationCodeOf(error)
    if (code) {
      // eslint-disable-next-line no-console
      console.warn('[kunRoute] violation', { ...context, code })
      return KUN_VIOLATION_MESSAGE[code]
    }
    // eslint-disable-next-line no-console
    console.error('[kunRoute] unhandled', context, error)
    throw error
  }
}

const toResponse = (result: KunRouteResult) =>
  result instanceof Response ? result : NextResponse.json(result)

const defineRoute =
  (method: KunRouteMethod) =>
  (def: KunRouteAnyDef): KunRouteHandler =>
  async (req, context) => {
    let params: unknown
    if (def.params) {
      const raw = (await context?.params) as KunRouteParams | undefined
      const parsed = def.params(raw ?? {})
      if (typeof parsed === 'string') {
        return NextResponse.json(parsed)
      }
      params = parsed
    }

    let input: unknown
    let actor: KunRoutePayload | null | undefined
    if (def.order === 'auth-first') {
      const auth = await authorize(req, def)
      if (!auth.ok) {
        return auth.response
      }
      actor = auth.actor
      input = await parseInput(method, req, def)
      if (typeof input === 'string') {
        return NextResponse.json(input)
      }
    } else {
      input = await parseInput(method, req, def)
      if (typeof input === 'string') {
        return NextResponse.json(input)
      }
      const auth = await authorize(req, def)
      if (!auth.ok) {
        return auth.response
      }
      actor = auth.actor
    }

    if (def.abuse?.length) {
      const denied = await kunAbuseGate(def.abuse, actor as KunRoutePayload)
      if (denied) {
        return NextResponse.json(denied)
      }
    }

    return toResponse(
      await runHandler(method, req, def, { req, input, params, actor } as never)
    )
  }

const queryRoute = defineRoute as (
  method: KunRouteMethod
) => <
  A extends KunRouteAuth,
  S extends KunRouteSchema | undefined = undefined,
  P = undefined
>(
  def: KunRouteInputDef<A, S, P>
) => KunRouteHandler

const bodyRoute = defineRoute as (
  method: KunRouteMethod
) => <
  A extends KunRouteAuth,
  S extends KunRouteSchema | undefined = undefined,
  P = undefined
>(
  def: KunRouteBodyDef<A, S, P>
) => KunRouteHandler

// PATCH / HEAD / OPTIONS 只有 OIDC 透传在用, 不解析输入
const bareRoute = defineRoute as (
  method: KunRouteMethod
) => <A extends KunRouteAuth, P = undefined>(
  def: KunRouteDefBase<A, undefined, P>
) => KunRouteHandler

export const kunRoute = {
  get: queryRoute('GET'),
  delete: queryRoute('DELETE'),
  post: bodyRoute('POST'),
  put: bodyRoute('PUT'),
  patch: bareRoute('PATCH'),
  head: bareRoute('HEAD'),
  options: bareRoute('OPTIONS')
}
