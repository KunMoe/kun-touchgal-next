// 跨文件承重不变量的注册表 (T40): 一条不变量一个规则 id。
//
// 为什么不写成 eslint.config.mjs 里的核心 no-restricted-imports / no-restricted-syntax:
// flat config 合并 rules 时, 后出现的同名规则只要带选项就整体替换前者。任何一个后来的
// 配置块再用一次这两条核心规则, 之前登记的禁令就在它的作用域内静默失效, CI 照样全绿。
// 每条不变量各占一个 kun/inv-* id 之后, 新规则只能新增 id, 覆盖不到别人。
//
// 登记门槛: 必须有能报错的 bad 样例 (lint/__tests__/kunInvariants.test.ts 逐条执行)。
// 这里只收由机器执行的代码约束, 不收生产状态和审查流程。

/**
 * @typedef {{
 *   id: `inv-${string}`,
 *   aliases?: string[],
 *   statement: string,
 *   reason: string,
 *   removeWhen: string,
 *   files?: string[],
 *   ignores?: string[],
 *   enforce:
 *     | { kind: 'import', sources: (string | RegExp)[], importNames?: string[], allowTypeImports?: boolean }
 *     | { kind: 'syntax', selectors: string[], strings?: RegExp[] },
 *   examples: { file: string, bad: string[], good: string[] }
 * }} KunInvariant
 */
// syntax 类的 strings: 字符串字面量与模板字符串命中任一正则即报。模板字符串按「各段文本用占位符
// $1 接起来」的整串匹配, 一句 SQL 被插值切成几段时关键字与列名仍在同一串里; 选择器只能逐段匹配

// inv-search-03 / 04 的成员名。Index 自己的 update / delete (改主键、删索引) 与 Prisma delegate
// 的方法同名, 按名字认不出来, 不在表里
const MEILI_DOCUMENT_WRITE =
  '/^(addDocuments|addDocumentsFromString|addDocumentsInBatches|updateDocuments|updateDocumentsByFunction|updateDocumentsFromString|updateDocumentsInBatches|deleteDocument|deleteDocuments|deleteAllDocuments)$/'
const MEILI_INDEX_ADMIN =
  '/^(createIndex|updateIndex|deleteIndex|deleteIndexIfExists|swapIndexes|(update|reset)(Settings|DisplayedAttributes|DistinctAttribute|Embedders|Faceting|FacetSearch|FilterableAttributes|LocalizedAttributes|NonSeparatorTokens|Pagination|PrefixSearch|ProximityPrecision|RankingRules|SearchableAttributes|SearchCutoffMs|SeparatorTokens|SortableAttributes|StopWords|Synonyms|TypoTolerance|Dictionary|ForeignKeys))$/'

// inv-content-05/06 共用。三张内容表的 Prisma delegate 名, user 上的同名关系字段与 _count 计数也叫这个名字
const CONTENT_DELEGATE = '/^patch_(comment|rating|resource)$/'
const CONTENT_UPDATE_METHODS = 'update|updateMany|updateManyAndReturn|upsert'
// 键名按标识符或字符串字面量认 (prettier 会去掉多余的引号, 带引号的键只在 prettier-ignore 下出现);
// 用在不拦计算键的位置时, 连模板字符串计算键 ([`patch_comment`]) 一起认
const keyIs = (re) => `:matches([key.name=${re}], [key.value=${re}])`
const keyOrTemplateIs = (re) =>
  `:matches([key.name=${re}], [key.value=${re}], [key.quasis.0.value.cooked=${re}])`

// delegate 一旦离开 `<obj>.<delegate>.<method>(...)` 的形状 (解构、别名、计算属性访问、当参数传走、
// 把方法取下来另调), 调用点上就没有方法名, 按方法名写的选择器看不到。所以直接报引用本身, 读也算。
// 只放行几种父节点: 被调用的非计算成员; methods 以外的非计算成员 (findMany、count …, 取值不调用也行);
// for…of 的右侧 (delegate 不可迭代, 只可能是 user.patch_resource 这类已加载的关系数组)。
// _count.patch_resource 与从 _count 里解构出来的都是关系计数, 不是 delegate
const detachedContentDelegate = (methods) => [
  `MemberExpression[computed=true]:matches([property.value=${CONTENT_DELEGATE}], [property.quasis.0.value.cooked=${CONTENT_DELEGATE}])`,
  `ObjectPattern > Property${keyOrTemplateIs(CONTENT_DELEGATE)}:not(VariableDeclarator:matches([init.property.name='_count'], [init.name='_count']) > ObjectPattern > Property, Property[key.name='_count'] > ObjectPattern > Property)`,
  `MemberExpression[computed=false][property.name=${CONTENT_DELEGATE}]:not([object.property.name='_count'], [object.name='_count'], ForOfStatement > MemberExpression.right, CallExpression > MemberExpression.callee[computed=false] > MemberExpression.object, MemberExpression[computed=false][property.name!=/^(${methods})$/] > MemberExpression.object)`
]

// raw SQL 里的三张内容表: 可带 schema 前缀与双引号; 表名后不得紧挨标识符字符, 不误伤
// patch_rating_stat、patch_resource_link 这类同前缀的表
const CONTENT_TABLE = String.raw`(?:"?\w+"?\.)?"?patch_(?:comment|rating|resource)\b"?`
// SET 列表到 WHERE / RETURNING 为止: 只在条件或返回列里出现的 status 不算写。单引号字符串整段跳过, 且引号
// 只能这样成对消耗: SET note = 'where' 不会提前截断, 也拼不出跨过 WHERE 的假配对 ('a' WHERE b = 'c')
const SET_STATUS = String.raw`SET\b(?:'[^']*'|(?!\b(?:WHERE|RETURNING)\b)[^'])*?\bstatus\b`

// 行内对象字面量; 外面包一层 TS 的 as / satisfies 也算 (只有类型, 运行时就是这个字面量), 包着别的表达式不算
const NOT_INLINE_VALUE =
  ":not([value.type='ObjectExpression'], [value.type=/^TS(As|Satisfies)Expression$/][value.expression.type='ObjectExpression'])"
const inlineObjectOf = (slot) =>
  `:matches(${slot} > ObjectExpression, ${slot} > :matches(TSAsExpression, TSSatisfiesExpression) > ObjectExpression)`

// update* 的写入体在 data, upsert 的在 update。upsert 的 create 与 create() 一样是插入时的初始状态
// (评论、评价、资源的创建入口都在 server/content 之外写初始 status), 不归本条管
const CONTENT_UPDATE = `CallExpression[callee.property.name=/^(${CONTENT_UPDATE_METHODS})$/][callee.object.property.name=${CONTENT_DELEGATE}]`
const PAYLOAD_KEY = keyIs('/^(data|update)$/')
const STATUS_KEY = keyIs('/^status$/')
const PAYLOAD_SLOT = `${CONTENT_UPDATE} > ObjectExpression > Property${PAYLOAD_KEY}`
const PAYLOAD = inlineObjectOf(PAYLOAD_SLOT)
// 写入体里这些键下面是过滤条件 (where、deleteMany 的参数) 或只能插入的写入体 (create、createMany),
// 其中的 status 与关系字段都不是对已有行的修改。只认 scope 以内的这些键
const outsideFilterOrInsert = (scope) =>
  `:not(${scope} Property${keyIs('/^(where|deleteMany|create|createMany)$/')} *)`

// 嵌套写: 任意 delegate 的 update / upsert 写入体里, 指向三张内容表的关系字段 (由 prisma/schema 推出,
// 这些字段名在 schema 里没有指向别的表的同名字段)。下挂 delete / deleteMany 是物理删除 (05),
// 下挂 update / updateMany / upsert 能改 status (06)。create 不收: 插入的写入体只接受 create / connect 类操作。
// 关系字段出现在非内容表的写入体里时没有别的检查拦计算键, 所以连模板字符串键也认
// lint/__tests__ 按 prisma/schema 核对这份清单: 新增或改名的关系字段会让测试变红
export const CONTENT_RELATION_FIELDS = [
  'comment',
  'parent',
  'patch_comment',
  'patch_rating',
  'patch_resource',
  'rating',
  'reply',
  'resource'
]
const CONTENT_RELATION = `/^(${CONTENT_RELATION_FIELDS.join('|')})$/`
const WRITE_ROOT = `CallExpression[callee.property.name=/^(update|upsert)$/] > ObjectExpression > Property${PAYLOAD_KEY}`
const RELATION_WRITE = `${WRITE_ROOT} Property${keyOrTemplateIs(CONTENT_RELATION)}${outsideFilterOrInsert(WRITE_ROOT)}`
// 关系字段的值必须是行内对象字面量且操作名字面可见, 否则藏得住 deleteMany / updateMany
const hiddenRelationWrite = [
  `${RELATION_WRITE}:not([value.type='ObjectExpression'])`,
  `${RELATION_WRITE} > ObjectExpression > :matches(SpreadElement, Property[computed=true])`
]
const NESTED_UPDATE = `${RELATION_WRITE} > ObjectExpression > Property${keyIs('/^(update|updateMany|upsert)$/')}`

// inv-authz-01/03 共用。角色值: 名为 role / userRole / currentUserRole 的裸标识符, 或属性名是这三个之一的成员访问
// (含可选链 r.user?.role、a?.b.role 与字符串键 x['role'])
const ROLE_NAME = '/^(role|userRole|currentUserRole)$/'
const ROLE_VALUE = `:matches(Identifier[name=${ROLE_NAME}], MemberExpression[computed=false][property.name=${ROLE_NAME}], MemberExpression[computed=true][property.value=${ROLE_NAME}], ChainExpression[expression.computed=false][expression.property.name=${ROLE_NAME}])`
// 外面包一层非空断言或 as / satisfies 也算 (只有类型, 运行时就是这个角色值)
const ROLE_WRAPPER =
  ':matches(TSNonNullExpression, TSAsExpression, TSSatisfiesExpression)'
// 角色常量: 数字字面量, 或 KUN_ROLE.<X> / KUN_ROLE['X']
const roleConstantAt = (side) =>
  `:matches([${side}.type='Literal'][${side}.value=type(number)], [${side}.type='MemberExpression'][${side}.object.name='KUN_ROLE'])`
const ROLE_COMPARE = 'BinaryExpression[operator=/^([<>]=?|[!=]==?)$/]'
// 报角色值那一侧; 另一侧是常量。两种操作数顺序各一条, 再各配一条带包装的
const roleComparedToConstant = () =>
  ['left', 'right'].flatMap((side) => {
    const other = side === 'left' ? 'right' : 'left'
    const compare = `${ROLE_COMPARE}${roleConstantAt(other)}`
    return [
      `${compare} > ${ROLE_VALUE}.${side}`,
      `${compare} > ${ROLE_WRAPPER}.${side} > ${ROLE_VALUE}.expression`
    ]
  })

// 对象字面量里写 role 键: 标识符键 (含简写 { ...actor, role }) 或字符串键; 不认 [role] 这种以变量为键的计算键
const ROLE_KEY =
  ":matches([computed=false][key.name='role'], [key.value='role'])"

// inv-auth-04。user 表上的凭据与权限列: 写它们要与安全戳在同一条语句里 (securityEvents.ts)
const CREDENTIAL_COLUMNS =
  'password|email|enable_2fa|two_factor_secret|two_factor_backup|role|status|security_stamp'
const USER_UPDATE = `CallExpression[callee.property.name=/^(update|updateMany|updateManyAndReturn|upsert)$/][callee.object.property.name='user']`
const USER_PAYLOAD = inlineObjectOf(
  `${USER_UPDATE} > ObjectExpression > Property${keyIs('/^(data|update)$/')}`
)

// inv-route-01。Route Handler 的导出名 (Next 认的 HTTP 方法) 与入口构造器
const HTTP_METHOD = '/^(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)$/'
const KUN_ROUTE_CALL =
  "CallExpression[callee.type='MemberExpression'][callee.object.name='kunRoute']"
const ROUTE_EXPORT = `ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=${HTTP_METHOD}]`
// inv-fetch-01。客户端 API 适配器 (utils/kunFetch.ts) 的五个导出
const KUN_FETCH_CALL =
  'CallExpression[callee.name=/^kunFetch(Get|Post|Put|Delete|FormData)$/]'
const HTTP_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS'
]

// inv-cache-01。资源族的四个失效 helper; 这些名字在仓库里只指这四个函数
const RESOURCE_CACHE_HELPER =
  '/^(invalidatePatchResourceDetailCache|invalidateResourceListCache|invalidateResourceStatsListCache|invalidateUserPendingResourceCache)$/'

// inv-identity-02。user 表按 where 定位行的调用: 读查询, 以及按唯一键定位一行的 update / upsert /
// delete (where: { email } 就是一次大小写敏感的 findUnique)。updateMany / deleteMany 不收: 它们的
// where 是写入的前置条件 (改邮箱以旧邮箱为条件的 CAS), 不是找人
const USER_LOCATE = `CallExpression[callee.property.name=/^(findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|findMany|count|aggregate|groupBy|update|upsert|delete)$/][callee.object.property.name='user']`
const USER_WHERE = `${USER_LOCATE} > ObjectExpression > Property${keyIs('/^where$/')} > ObjectExpression`
// where 顶层的 name / email, 以及 AND / OR / NOT 里任意深度的; 关系过滤 (patch: { some: { name } })
// 里的 name 是别的表的列, 不算
const USER_WHERE_IDENTIFIERS = [
  `${USER_WHERE} > Property${keyIs('/^(name|email)$/')}`,
  `${USER_WHERE} > Property${keyIs('/^(AND|OR|NOT)$/')} Property${keyIs('/^(name|email)$/')}`
]

// inv-list-01。服务端实体上会被复制进叶子组件 useState 的点赞字段
const USE_STATE_CALL =
  "CallExpression:matches([callee.name='useState'], [callee.property.name='useState'])"
const LIKE_FIELD = '/^(isLike|likeCount)$/'

// inv-value-01: 成员访问的对象是 <任意命名空间>.coerce (计算键也算), 或从 zod 具名导入 / 解构出的 coerce
const COERCE_OBJECT =
  "[object.type='Identifier'][object.name='coerce'], [object.type='MemberExpression'][object.computed=false][object.property.name='coerce'], [object.type='MemberExpression'][object.property.value='coerce']"
const COERCE_INIT =
  "[init.type='MemberExpression'][init.computed=false][init.property.name='coerce'], [init.type='MemberExpression'][init.property.value='coerce']"

/** @type {KunInvariant[]} */
export const KUN_INVARIANTS = [
  {
    id: 'inv-bundle-01',
    aliases: ['C9'],
    statement: "zod 必须用命名空间导入: import * as z from 'zod'",
    reason:
      'zod 根入口的 z 是整个命名空间再导出, Turbopack 无法按成员裁剪, 具名/默认导入会打进全量 zod (含 62 个语言包, 约 90KB gz); 命名空间导入实测 32KB',
    removeWhen: 'bundler 能按成员裁剪 zod 根入口的 z 再导出',
    // 用选择器而不是 import 类的 importNames: 后者会连 import * as z 一起拦
    enforce: {
      kind: 'syntax',
      selectors: [
        "ImportDeclaration[source.value='zod'][importKind!='type'] > :matches(ImportSpecifier[imported.name='z'][importKind!='type'], ImportDefaultSpecifier)"
      ]
    },
    examples: {
      file: 'validations/kunInvariantExample.ts',
      bad: ["import { z } from 'zod'", "import z from 'zod'"],
      good: ["import * as z from 'zod'", "import type { z } from 'zod'"]
    }
  },
  {
    id: 'inv-bundle-02',
    aliases: ['C19'],
    statement: "只许从 '@bprogress/next/app' 子路径导入, 不得导入根入口",
    reason:
      '根入口顶层 import next/router 并给 PagesProgress 赋 displayName, 补 sideEffects:false 也裁不掉, 整套 Pages Router (46 模块, 约 23KB gz) 会进全站 layout 块; 子路径的前 273 行与根入口逐字相同, useRouter 是同一个函数',
    removeWhen: '@bprogress/next 根入口不再顶层引用 next/router',
    enforce: { kind: 'import', sources: ['@bprogress/next'] },
    examples: {
      file: 'components/kun/KunInvariantExample.tsx',
      bad: ["import { useRouter } from '@bprogress/next'"],
      good: ["import { useRouter } from '@bprogress/next/app'"]
    }
  },
  {
    id: 'inv-store-01',
    statement:
      'zustand 的 use*Store() 必须带 selector, 且不能是返回整个 state 的恒等 selector',
    reason:
      '不带 selector 或写成 (state) => state 都会订阅整个 store, 任一字段变化都让调用组件重渲染',
    removeWhen: '全仓不再使用 zustand',
    enforce: {
      kind: 'syntax',
      selectors: [
        'CallExpression[callee.name=/^use[A-Z]\\w*Store$/][arguments.length=0]',
        // 函数体是裸标识符的箭头函数: 要么原样返回参数, 要么返回与 store 无关的外部变量
        "CallExpression[callee.name=/^use[A-Z]\\w*Store$/] > ArrowFunctionExpression[body.type='Identifier']"
      ]
    },
    examples: {
      file: 'components/kun/KunInvariantExample.tsx',
      bad: [
        'const state = useUserStore()',
        'const state = useUserStore((state) => state)'
      ],
      good: [
        'const uid = useUserStore((state) => state.user.uid)',
        'const [uid, name] = useUserStore(useShallow((state) => [state.user.uid, state.user.name]))'
      ]
    }
  },
  {
    id: 'inv-content-01',
    statement:
      'html-to-text 只许在 server/content/text.ts 里导入, 其余一律用 kunHtmlToText',
    reason:
      '各处自配 convert 选项会让同一段 HTML 得到不同的文本 (描述与 og 曾因此不一致); 对 markdown 原文跑 HTML 转换器还会把 <…> 当标签吞掉',
    removeWhen: '全仓不再需要 HTML → 纯文本投影',
    ignores: ['server/content/text.ts'],
    enforce: { kind: 'import', sources: ['html-to-text'] },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: ["import { convert } from 'html-to-text'"],
      good: ["import { kunHtmlToText } from '~/server/content/text'"]
    }
  },
  {
    id: 'inv-content-02',
    statement:
      '服务端与 metadata 不得用 markdownToText 取文本, 改从已净化 HTML 经 kunHtmlToText 派生',
    reason:
      'markdownToText 是按正则近似的客户端工具, 不认识指令与内嵌 HTML, 输出与读者实际看到的渲染结果不一致',
    removeWhen: 'utils/markdownToText 被删除',
    files: ['app/api/**', 'server/**', 'app/**/metadata.ts'],
    enforce: {
      kind: 'import',
      sources: [/(^|\/)utils\/markdownToText(\.tsx?)?$/]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "import { markdownToText } from '~/utils/markdownToText'",
        "import { markdownToText } from '~/utils/markdownToText.tsx'"
      ],
      good: ["import { kunHtmlToText } from '~/server/content/text'"]
    }
  },
  {
    id: 'inv-content-03',
    statement: '`as KunSafeHtml` 只许出现在登记的生产者文件里',
    reason:
      '品牌只存在于编译期, 随手断言等于把没渲染过的字符串放行到 HTML 汇点与文本投影',
    removeWhen: 'KunSafeHtml 品牌被移除',
    // 生产者: 服务端 markdown 渲染的唯一入口、落库 HTML 读取器、编辑器预览器,
    // 以及两处客户端净化 / 高亮 (DOMPurify、sugar-high)
    ignores: [
      'app/api/utils/render/renderKunMarkdown.ts',
      'app/api/patch/comment/html.ts',
      'utils/markdownPreview.ts',
      'components/patch/resource/kun/KunResourceDownload.tsx',
      'lib/mdx/element/KunCode.tsx'
    ],
    enforce: {
      kind: 'syntax',
      selectors: [
        "TSAsExpression > TSTypeReference[typeName.name='KunSafeHtml']",
        "TSTypeAssertion > TSTypeReference[typeName.name='KunSafeHtml']"
      ]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "export const html = '<p>x</p>' as KunSafeHtml",
        'export const cast = (raw: string) => raw as unknown as KunSafeHtml'
      ],
      good: [
        'export const size = (html: KunSafeHtml) => html.length',
        'export const load = async (): Promise<KunSafeHtml> => render()'
      ]
    }
  },
  {
    id: 'inv-content-04',
    statement: 'dangerouslySetInnerHTML 的值必须是 kunInnerHtml(...) 调用',
    reason:
      '__html 的类型在结构上什么都收; 只有 kunInnerHtml 的入参把来源收窄到 KunSafeHtml',
    removeWhen: '全仓不再使用 dangerouslySetInnerHTML',
    enforce: {
      kind: 'syntax',
      selectors: [
        "JSXAttribute[name.name='dangerouslySetInnerHTML'] > JSXExpressionContainer > :not(CallExpression[callee.name='kunInnerHtml'])"
      ]
    },
    examples: {
      file: 'components/kun/KunInvariantExample.tsx',
      bad: [
        'export const A = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />'
      ],
      good: [
        'export const A = ({ html }: { html: KunSafeHtml }) => <div dangerouslySetInnerHTML={kunInnerHtml(html)} />'
      ]
    }
  },
  {
    id: 'inv-content-05',
    statement:
      '评论、评价、资源三张内容表的物理删除只许出现在 server/content/** 的命令里',
    reason:
      '删除要在行锁下复检状态, 并按固定顺序清理通知、审核任务、申诉、孤儿举报与出箱; 入口各写一份时曾反复漏步 (举报与申诉删评论不清通知, 申诉驳回删资源不清评论派生物)',
    removeWhen: '三张内容表的删除改由数据库外键与触发器完整承载',
    files: ['app/**/*.ts', 'server/**/*.ts', 'migration/**/*.ts'],
    // 测试做不了生产写入, 却常要 mock / 断言这些方法 (vi.spyOn(prisma.patch_comment, …))
    ignores: ['server/content/**', '**/__tests__/**'],
    enforce: {
      kind: 'syntax',
      selectors: [
        `CallExpression[callee.property.name=/^(delete|deleteMany)$/][callee.object.property.name=${CONTENT_DELEGATE}]`,
        ...detachedContentDelegate('delete|deleteMany'),
        `${RELATION_WRITE} > ObjectExpression > Property${keyIs('/^(delete|deleteMany)$/')}`,
        ...hiddenRelationWrite
      ],
      strings: [
        new RegExp(
          String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${CONTENT_TABLE}`,
          'i'
        ),
        // 表清单只由标识符、引号、点、逗号与空白组成
        new RegExp(String.raw`\bTRUNCATE\s[\w\s".,]*?${CONTENT_TABLE}`, 'i')
      ]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        'export const run = (tx: any) => tx.patch_comment.deleteMany({ where: { id: 1 } })',
        'export const run = (prisma: any) => prisma.patch_resource.delete({ where: { id: 1 } })',
        'export const run = (tx: any) => { const { patch_comment } = tx; return patch_comment.deleteMany({ where: { id: 1 } }) }',
        "export const run = (tx: any) => { const { ['patch_resource']: resources } = tx; return resources.deleteMany({ where: { id: 1 } }) }",
        'export const run = (tx: any) => { const { [`patch_comment`]: comments } = tx; return comments.deleteMany({ where: { id: 1 } }) }',
        'export const run = (tx: any) => { const comments = tx.patch_comment; return comments.delete({ where: { id: 1 } }) }',
        "export const run = (tx: any) => tx['patch_comment'].delete({ where: { id: 1 } })",
        'export const run = (tx: any) => tx[`patch_rating`].deleteMany({ where: { id: 1 } })',
        'export const run = (tx: any) => purgeAll(tx.patch_resource)',
        "export const run = (tx: any) => tx.patch_comment['delete']({ where: { id: 1 } })",
        'export const run = (tx: any) => { const remove = tx.patch_comment.delete; return remove({ where: { id: 1 } }) }',
        'export const run = (tx: any, id: number) => tx.$executeRaw`DELETE FROM patch_comment WHERE id = ${id}`',
        'export const run = (tx: any, id: number) => tx.$executeRawUnsafe(\'delete from only "public"."patch_resource" where id = $1\', id)',
        'export const run = (tx: any) => tx.$executeRaw`TRUNCATE patch_report, patch_rating`',
        'export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { comment: { deleteMany: {} } } })',
        'export const run = (tx: any) => tx.patch_comment.update({ where: { id: 1 }, data: { reply: { deleteMany: {} } } })',
        'export const run = (tx: any) => tx.patch_report.update({ where: { id: 1 }, data: { comment: { delete: true } } })',
        'export const run = (tx: any) => tx.patch_comment.update({ where: { id: 1 }, data: { parent: { delete: true } } })',
        'export const run = (tx: any) => tx.user.update({ where: { id: 1 }, data: { patch_comment: { deleteMany: {} } } })',
        'export const steps = (tx: any) => ({ create: () => tx.patch.update({ where: { id: 1 }, data: { comment: { deleteMany: {} } } }) })',
        "export const run = (tx: any) => tx.user.upsert({ where: { id: 1 }, create: { name: 'x' }, update: { patch_rating: { deleteMany: { patch_id: 1 } } } })",
        'export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { resource: { update: { where: { id: 2 }, data: { comment: { deleteMany: {} } } } } } })',
        "export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { ['resource']: { deleteMany: {} } } })",
        'export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { [`rating`]: { deleteMany: {} } } })',
        "export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { comment: { 'deleteMany': {} } } })",
        'export const run = (tx: any, ops: any) => tx.patch.update({ where: { id: 1 }, data: { comment: ops } })',
        'export const run = (tx: any, ops: any) => tx.patch.update({ where: { id: 1 }, data: { rating: { ...ops } } })',
        'export const run = (tx: any, op: string) => tx.patch.update({ where: { id: 1 }, data: { rating: { [op]: {} } } })'
      ],
      good: [
        'export const run = (tx: any) => tx.patch_report.deleteMany({ where: { id: 1 } })',
        'export const run = (tx: any) => tx.patch_rating.findMany({ where: { id: 1 } })',
        'export const pick = (tx: any) => [tx.patch_comment.findMany, tx.patch_resource.count]',
        'export const count = (user: any, { _count }: any) => user._count.patch_resource + user.sender?._count.patch_comment + _count.patch_rating',
        'export const run = (tx: any) => { const { patch_report } = tx; return patch_report.deleteMany({ where: { id: 1 } }) }',
        'export const run = (tx: any, id: number) => tx.$queryRaw`SELECT id FROM patch_comment WHERE id = ${id} FOR UPDATE`',
        'export const run = (tx: any, id: number) => tx.$executeRaw`DELETE FROM patch_resource_link WHERE resource_id = ${id}`',
        "export const run = (tx: any, id: number) => tx.$executeRawUnsafe('DELETE FROM patch_rating_like WHERE patch_rating_id = $1', id)",
        "export const message = '正文过长, truncate 后再写回 patch_comment'",
        'export const run = (user: any, p: any) => { for (const r of user.patch_resource) r.id; const { patch_comment } = p._count; const { patch_rating } = _count; const { _count: { patch_resource } } = user; return patch_comment + patch_rating + patch_resource }',
        'export const run = (tx: any, links: any[]) => tx.patch_resource.update({ where: { id: 1 }, data: { links: { deleteMany: {}, create: links } } })',
        'export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { tag: { deleteMany: {} }, alias: { deleteMany: {} }, company: { deleteMany: {} } } })',
        'export const run = (tx: any) => tx.patch_report.update({ where: { id: 1 }, data: { comment: { disconnect: true }, rating: { connect: { id: 2 } } } })',
        'export const run = (tx: any, f: any) => tx.user.update({ where: { id: 1 }, data: { patch_resource_like: { deleteMany: { resource: f } } } })',
        'export const run = (tx: any, f: any, now: Date) => tx.user.update({ where: { id: 1 }, data: { patch_resource_like: { updateMany: { where: { resource: f }, data: { created: now } } } } })',
        "export const run = (tx: any, target: any) => tx.patch.update({ where: { id: 1 }, data: { report: { create: { content: 'x', comment: target } } } })",
        "export const run = (tx: any, ops: any) => tx.patch.create({ data: { name: 'x', comment: ops } })"
      ]
    }
  },
  {
    id: 'inv-content-06',
    statement:
      '评论、评价、资源三张内容表的 status 写入只许出现在 server/content/** 的命令里',
    reason:
      '状态迁移要先锁行、只对锁下实际迁移的行作废审核任务并重算聚合; 入口直接写 status 时出现过守卫读事务外快照、作废集合与迁移集合不一致',
    removeWhen: '内容状态不再由应用层写入',
    files: ['app/**/*.ts', 'server/**/*.ts', 'migration/**/*.ts'],
    // 测试做不了生产写入, 却常要 mock / 断言这些方法 (vi.spyOn(prisma.patch_comment, …))
    ignores: ['server/content/**', '**/__tests__/**'],
    // 写入体必须让 status 键字面可见: 实参与写入体都是行内对象字面量 (写入体可包一层 as / satisfies),
    // 不许计算键; 展开只许展开两支都是对象字面量的三元, 被展开的字面量里不再嵌套展开或计算键。
    // 嵌套的 update / updateMany / upsert 更严: 写入体里不许任何展开与计算键, 数组形式的每一项都得是字面量
    enforce: {
      kind: 'syntax',
      selectors: [
        `${PAYLOAD} Property${STATUS_KEY}${outsideFilterOrInsert(PAYLOAD)}`,
        `${CONTENT_UPDATE}:not([arguments.0.type='ObjectExpression'])`,
        `${CONTENT_UPDATE} > ObjectExpression > :matches(SpreadElement, Property[computed=true])`,
        `${PAYLOAD_SLOT}${NOT_INLINE_VALUE}`,
        `${PAYLOAD} > Property[computed=true]`,
        `${PAYLOAD} > SpreadElement:not([argument.type='ConditionalExpression'][argument.consequent.type='ObjectExpression'][argument.alternate.type='ObjectExpression'])`,
        `${PAYLOAD} > SpreadElement ObjectExpression > :matches(SpreadElement, Property[computed=true])`,
        ...detachedContentDelegate(CONTENT_UPDATE_METHODS),
        ...hiddenRelationWrite,
        `${NESTED_UPDATE}:not([value.type='ObjectExpression'], [value.type='ArrayExpression'])`,
        `${NESTED_UPDATE} > ArrayExpression > :not(ObjectExpression)`,
        `:matches(${NESTED_UPDATE} > ObjectExpression, ${NESTED_UPDATE} > ArrayExpression > ObjectExpression) > Property${PAYLOAD_KEY}${NOT_INLINE_VALUE}`,
        `${NESTED_UPDATE} Property${STATUS_KEY}${outsideFilterOrInsert(NESTED_UPDATE)}`,
        `${NESTED_UPDATE} ObjectExpression > :matches(SpreadElement, Property[computed=true])${outsideFilterOrInsert(NESTED_UPDATE)}`
      ],
      strings: [
        new RegExp(
          String.raw`\bUPDATE\s+(?:ONLY\s+)?${CONTENT_TABLE}(?:\s+(?:AS\s+)?\w+)?\s+${SET_STATUS}`,
          'i'
        ),
        new RegExp(
          String.raw`\bINSERT\s+INTO\s+${CONTENT_TABLE}[\s\S]*?\bDO\s+UPDATE\s+${SET_STATUS}`,
          'i'
        )
      ]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        'export const run = (tx: any) => tx.patch_rating.update({ where: { id: 1 }, data: { status: 2 } })',
        'export const run = (tx: any, intercept: boolean) => tx.patch_comment.updateMany({ where: { id: 1 }, data: { ...(intercept ? { status: 1 } : {}) } })',
        'export const run = (tx: any) => { const { patch_rating } = tx; return patch_rating.update({ where: { id: 1 }, data: { status: 2 } }) }',
        'export const run = (tx: any) => { const ratings = tx.patch_rating; return ratings.updateMany({ where: { id: 1 }, data: { status: 2 } }) }',
        "export const run = (tx: any) => tx['patch_comment'].update({ where: { id: 1 }, data: { status: 2 } })",
        'export const run = (tx: any) => { const write = tx.patch_comment.update; return write({ where: { id: 1 }, data: { status: 2 } }) }',
        'export const run = (tx: any) => transitionAll(tx.patch_resource, 1)',
        'export const run = (tx: any) => { const data = { status: 2 }; return tx.patch_comment.update({ where: { id: 1 }, data }) }',
        'export const run = (tx: any) => tx.patch_comment.update({ where: { id: 1 }, data: buildData() })',
        'export const run = (tx: any, args: any) => tx.patch_rating.updateMany(args)',
        'export const run = (tx: any, rest: any) => tx.patch_resource.update({ where: { id: 1 }, ...rest })',
        'export const run = (tx: any, key: string) => tx.patch_resource.update({ where: { id: 1 }, [key]: { status: 1 } })',
        'export const run = (tx: any, fields: any) => tx.patch_comment.update({ where: { id: 1 }, data: { ...fields } })',
        'export const run = (tx: any, fields: any, flag: boolean) => tx.patch_comment.update({ where: { id: 1 }, data: { ...(flag ? fields : {}) } })',
        "export const run = (tx: any, fields: any, flag: boolean) => tx.patch_comment.update({ where: { id: 1 }, data: { ...(flag ? { content: 'x' } : fields) } })",
        'export const run = (tx: any, fields: any, flag: boolean) => tx.patch_comment.update({ where: { id: 1 }, data: { ...(flag ? { ...fields } : {}) } })',
        'export const run = (tx: any, key: string, flag: boolean) => tx.patch_comment.update({ where: { id: 1 }, data: { ...(flag ? { [key]: 2 } : {}) } })',
        'export const run = (tx: any, key: string) => tx.patch_comment.update({ where: { id: 1 }, data: { [key]: 2 } })',
        "export const run = (tx: any) => tx.patch_comment.update({ where: { id: 1 }, data: { 'status': 2 } })",
        "export const run = (tx: any) => tx.patch_comment.update({ where: { id: 1 }, 'data': { status: 2 } })",
        "export const run = (tx: any) => tx.patch_resource.upsert({ where: { id: 1 }, create: { name: 'x' }, update: { status: 1 } })",
        "export const run = (tx: any, patch: any) => tx.patch_resource.upsert({ where: { id: 1 }, create: { name: 'x' }, update: patch })",
        'export const run = (tx: any, s: number, id: number) => tx.$executeRaw`UPDATE patch_comment SET status = ${s} WHERE id = ${id}`',
        'export const run = (tx: any, n: string, s: number, id: number) => tx.$executeRaw`UPDATE patch_resource SET name = ${n}, status = ${s} WHERE id = ${id}`',
        'export const run = (tx: any, s: number, id: number) => tx.$executeRawUnsafe(\'update only "patch_rating" as r set "status" = $1 where r.id = $2\', s, id)',
        'export const run = (id: number) => Prisma.sql`INSERT INTO patch_comment (id, status) VALUES (${id}, 1) ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`',
        "export const run = (tx: any, s: number, id: number) => tx.$executeRaw`UPDATE patch_comment SET content = 'where', status = ${s} WHERE id = ${id}`",
        'export const run = (tx: any, fields: any) => tx.patch_comment.update({ where: { id: 1 }, data: fields satisfies object })',
        'export const run = (tx: any) => tx.patch_comment.update({ where: { id: 1 }, data: { status: 2 } satisfies object })',
        'export const steps = (tx: any) => ({ where: () => tx.patch_comment.update({ where: { id: 1 }, data: { status: 2 } }) })',
        'export const run = (tx: any, fields: any) => tx.patch_comment.update({ where: { id: 1 }, data: { ...fields } as object })',
        'export const run = (tx: any) => tx.user.update({ where: { id: 1 }, data: { patch_resource: { updateMany: { where: {}, data: { status: 1 } } } } })',
        'export const run = (tx: any) => tx.patch_report.update({ where: { id: 1 }, data: { comment: { update: { status: 2 } } } })',
        'export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { rating: { updateMany: [{ where: { id: 2 }, data: { status: 2 } }] } } })',
        "export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { resource: { upsert: { where: { id: 2 }, create: { name: 'x' }, update: { status: 1 } } } } })",
        'export const run = (tx: any, ops: any) => tx.patch.update({ where: { id: 1 }, data: { resource: ops } })',
        'export const run = (tx: any, args: any) => tx.patch.update({ where: { id: 1 }, data: { comment: { updateMany: args } } })',
        'export const run = (tx: any, args: any) => tx.patch.update({ where: { id: 1 }, data: { comment: { updateMany: [args] } } })',
        'export const run = (tx: any, fields: any) => tx.patch.update({ where: { id: 1 }, data: { comment: { update: { where: { id: 2 }, data: fields } } } })',
        'export const run = (tx: any, fields: any) => tx.patch.update({ where: { id: 1 }, data: { rating: { updateMany: [{ where: { id: 2 }, data: fields }] } } })',
        'export const run = (tx: any, fields: any) => tx.patch.update({ where: { id: 1 }, data: { comment: { update: { where: { id: 2 }, data: { ...fields } } } } })',
        'export const run = (tx: any, key: string) => tx.patch.update({ where: { id: 1 }, data: { comment: { update: { where: { id: 2 }, data: { [key]: 2 } } } } })'
      ],
      good: [
        "export const run = (tx: any) => tx.patch_comment.update({ where: { id: 1, status: 0 }, data: { content: 'x' } })",
        'export const run = (tx: any) => tx.user.update({ where: { id: 1 }, data: { status: 2 } })',
        'export const run = (tx: any) => tx.patch_resource.update({ where: { id: 1 }, data: { download: { increment: 1 } } })',
        'export const run = (tx: any, content: string) => tx.patch_comment.update({ where: { id: 1 }, data: { content, edited: true } })',
        'export const run = (tx: any, t: string[], p?: string[]) => tx.patch_resource.updateMany({ where: { id: 1 }, data: { type: { set: t }, ...(p ? { platform: { set: p } } : {}) } })',
        "export const run = (tx: any) => tx.patch_resource.upsert({ where: { id: 1 }, create: { name: 'x', status: 0 }, update: { name: 'x' } })",
        'export const run = (tx: any, prepared: any) => tx.patch_comment.create({ data: { ...prepared, status: 1 } })',
        'export const pick = (tx: any) => [tx.patch_comment.findMany, tx.patch_resource.count]',
        'export const count = (user: any, { _count }: any) => user._count.patch_resource + user.sender?._count.patch_comment + _count.patch_rating',
        'export const run = (tx: any, c: string, id: number) => tx.$executeRaw`UPDATE patch_comment SET content = ${c} WHERE id = ${id} AND status = 0`',
        'export const run = (tx: any, id: number) => tx.$executeRaw`UPDATE patch_resource SET download = download + 1 WHERE id = ${id}`',
        'export const run = (tx: any, p: string, id: number) => tx.$executeRaw`UPDATE patch_rating SET play_status = ${p} WHERE id = ${id}`',
        'export const run = (tx: any, c: string, id: number) => tx.$executeRaw`INSERT INTO patch_comment (id, content) VALUES (${id}, ${c}) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content RETURNING id, status`',
        'export const run = (tx: any, id: number) => tx.$queryRaw`SELECT status FROM patch_resource WHERE id = ${id} FOR UPDATE`',
        'export const run = (tx: any, id: number) => tx.$executeRaw`INSERT INTO patch_rating_stat (patch_id, count) VALUES (${id}, 1) ON CONFLICT (patch_id) DO UPDATE SET count = EXCLUDED.count`',
        'export const run = (tx: any, s: number, id: number) => tx.$executeRaw`UPDATE patch_rating_like SET status = ${s} WHERE id = ${id}`',
        "export const run = (tx: any, id: number) => tx.$executeRaw`UPDATE patch_comment SET content = 'a' WHERE note = 'b' AND status = 0 AND id = ${id}`",
        "export const run = (tx: any) => tx.patch_comment.update({ where: { id: 1 }, data: { content: 'x' } satisfies object })",
        "export const run = (tx: any) => tx.patch_comment.update({ where: { id: 1 }, data: { content: 'x' } as object })",
        "export const run = (tx: any) => tx.patch_comment.update({ where: { id: 1 }, data: { reply: { create: { content: 'x', status: 1 } } } })",
        'export const run = (user: any, p: any) => { for (const r of user.patch_resource) r.id; const { patch_comment } = p._count; const { patch_rating } = _count; const { _count: { patch_resource } } = user; return patch_comment + patch_rating + patch_resource }',
        'export const run = (tx: any, links: any[]) => tx.patch_resource.update({ where: { id: 1 }, data: { links: { deleteMany: {}, create: links } } })',
        "export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { comment: { updateMany: { where: { status: 0 }, data: { content: 'x' } } } } })",
        "export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { rating: { updateMany: [{ where: { id: 2 }, data: { short_summary: 'x' } }] } } })",
        "export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { resource: { upsert: { where: { id: 2 }, create: { name: 'x', status: 0 }, update: { name: 'x' } } } } })",
        "export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { comment: { update: { where: { id: 2 }, data: { reply: { createMany: { data: [{ content: 'x', status: 1 }] } } } } } } })",
        'export const run = (tx: any, reply: any) => tx.patch.update({ where: { id: 1 }, data: { comment: { update: { where: { id: 2 }, data: { reply: { create: { ...reply } } } } } } })',
        "export const run = (tx: any) => tx.patch.update({ where: { id: 1 }, data: { comment: { update: { where: { id: 2 }, data: { content: 'x' } satisfies object } } } })",
        'export const run = (tx: any) => tx.user.update({ where: { id: 1 }, data: { patch_comment_like: { updateMany: { where: { id: 2 }, data: { status: 1 } } } } })'
      ]
    }
  },
  {
    id: 'inv-authz-01',
    statement:
      '角色值不得与数字字面量或 KUN_ROLE.<X> 比较, 权限判断一律走 can(subject, capability)',
    reason:
      '门槛散落成数字比较时, 调一次门槛要逐处找, 两次调整都留下了漏改的位置, 客户端的镜像也与服务端分叉过; constants/permission.ts 的能力表是门槛的唯一事实源',
    removeWhen: '角色不再是有序整数, 或权限改由数据库 / 外部授权服务承载',
    // 能力表本身要拿角色与门槛比较
    ignores: ['constants/role.ts', 'constants/permission.ts'],
    enforce: { kind: 'syntax', selectors: roleComparedToConstant() },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        'export const deny = (payload: any) => payload.role < 4',
        'export const allow = (x: any) => 3 <= x.role',
        'export const official = (r: any) => r.user?.role > 2',
        'export const admin = (a: any) => a?.b.role >= 3',
        'export const isSuper = (role: number) => role === 4',
        'export const deny = (userRole: number) => userRole < 3',
        'export const notUser = (currentUserRole: number) => currentUserRole !== 1',
        'export const exempt = (options: any) => options.userRole >= 4',
        "export const creator = (user: any) => user['role'] == 2",
        'export const isSuper = (user: any) => user.role === KUN_ROLE.SUPER_ADMIN',
        'export const deny = (user: any) => KUN_ROLE.ADMIN > user.role',
        'export const admin = (user: any) => user.role! >= 3',
        'export const admin = (user: any) => (user.role as number) >= 3',
        'export const canDelete = (comment: any, uid: number, userRole: number) => comment.user_id !== uid && userRole < 3'
      ],
      good: [
        "export const admin = (payload: any) => can(payload, 'admin.access')",
        'export const same = (user: any, other: any) => user.role === other.role',
        'export const many = (x: any) => x.roleCount > 3',
        'export const label = (user: any) => KUN_ROLE_LABEL[toKunRole(user.role)]',
        'export const level = (LEVEL: any, role: number) => LEVEL[role] > 3',
        "export const assistant = (message: any) => message.role === 'assistant'",
        'export const self = (user: any) => user.uid === 4',
        'export const ordered = (role: number, threshold: number) => role >= threshold',
        'export const narrow = (user: any) => toKunRole(user.role)'
      ]
    }
  },
  {
    id: 'inv-authz-02',
    statement:
      '断言目标类型里出现 KunActor 的 as / <> 断言只许出现在会话解析器 (server/auth/session.ts 的 resolveKunSiteSession) 与测试 helper 里',
    reason:
      'KunActor 的品牌只存在于编译期, 代表「会话已校验、角色取自库里」; 随手断言等于把未校验的 payload 放行到所有按 KunActor 收参的权限判断',
    removeWhen: 'KunActor 品牌被移除',
    // 构造点: 会话校验后从库里取角色的唯一入口, 以及测试用的 actor 工厂
    ignores: [
      'server/auth/session.ts',
      'app/api/utils/__tests__/kunTestActor.ts'
    ],
    // 只看断言的目标类型子树 (含交叉 / 联合 / 泛型实参 / 命名空间限定 / import 类型),
    // 被断言的表达式里出现 KunActor (fn<KunActor>(x) as Other) 不算
    enforce: {
      kind: 'syntax',
      selectors: [
        ":matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation Identifier[name='KunActor']"
      ]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        'export const forge = (payload: any) => payload as KunActor',
        'export const forge = (payload: KunGalgamePayload) => payload as KunGalgamePayload & KunActor',
        'export const forge = (payload: unknown) => payload as unknown as KunActor',
        'export const forge = (payload: any) => <KunActor>payload',
        'export const forge = (payload: any) => payload as KunActor | null',
        'export const forge = (list: any[]) => list as KunActor[]',
        'export const forge = (payload: any) => payload as Role.KunActor',
        "export const forge = (payload: any) => payload as import('~/constants/role').KunActor"
      ],
      good: [
        'export const uid = (actor: KunActor) => actor.uid',
        'export const keep = (payload: KunGalgamePayload & KunActor): KunActor => payload',
        'export const load = (payload: KunActor) => { const actor: KunActor = payload; return actor }',
        'export const pick = (x: unknown) => fn<KunActor>(x) as Other',
        'export const load = async (req: Request): Promise<KunActor | null> => verifyAndLoadUser(req)',
        'export const subject = (s: KunSubject) => s as KunSubject'
      ]
    }
  },
  {
    id: 'inv-authz-03',
    statement:
      '对象字面量里展开之后不得再写 role 键; 构造 KunActor 只许在会话解析器 (resolveKunSiteSession) 里',
    reason:
      '{ ...actor, role: 4 } 不需要断言就能得到带品牌的 KunActor (展开保留品牌, TS 不拦), 角色被换掉而 inv-authz-02 看不到',
    removeWhen: 'KunActor 品牌被移除, 或改为不可展开的类实例',
    // KunActor 只在服务端流动; 客户端的表单与 store 更新 ({ ...user, role }) 与它无关
    files: ['app/**', 'server/**', 'middleware/**', 'utils/**', 'lib/**'],
    // 测试的输入夹具常写 { ...baseInput, role: 2 }; 测试要的 actor 走 __tests__/kunTestActor.ts
    ignores: ['server/auth/session.ts', '**/__tests__/**'],
    // 只认写在展开之后的 role 键 (写在展开之前的会被展开盖掉, 换不掉角色): 会话 DTO
    // ({ role: user.role, ..., ...redirectConfig }) 这类 role 在前的写法不报。
    // 展开的实参不限名字: ctx.actor、条件展开、任意变量名都算
    enforce: {
      kind: 'syntax',
      selectors: [`ObjectExpression > SpreadElement ~ Property${ROLE_KEY}`]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        'export const forge = (payload: KunActor) => ({ ...payload, role: 4 })',
        'export const forge = (actor: KunActor, role: KunRole) => ({ ...actor, role })',
        "export const forge = (viewer: KunActor) => ({ ...viewer, 'role': 4 })",
        'export const forge = (user: any, row: any) => ({ ...user, name: row.name, role: toKunRole(row.role) })',
        'export const forge = (ctx: any) => ({ ...ctx.actor, role: KUN_ROLE.ADMIN })',
        'export const forge = (actor: KunActor, guest: KunSubject, ok: boolean) => ({ ...(ok ? actor : guest), role: 4 })'
      ],
      good: [
        'export const dto = (user: any) => ({ uid: user.id, role: user.role })',
        'export const dto = (user: any, redirectConfig: object) => ({ uid: user.id, role: user.role, ...redirectConfig })',
        "export const rename = (payload: any) => ({ ...payload, name: 'x' })",
        'export const nested = (payload: any) => ({ ...payload, user: { role: 4 } })',
        'export const flag = (payload: any, role: string) => ({ ...payload, [role]: true })',
        'export const strip = ({ role, ...rest }: any) => ({ ...rest })'
      ]
    }
  },
  {
    id: 'inv-authz-04',
    statement: 'kunTestActor 只许在 __tests__ 下导入',
    reason:
      '它是测试里构造 KunActor 的入口, 任何 uid 与角色都能造出带品牌的操作者; 生产代码导入它等于绕过会话校验, 而且是最顺手的一种绕法',
    removeWhen: 'KunActor 品牌被移除',
    ignores: ['**/__tests__/**'],
    enforce: {
      kind: 'import',
      sources: [/(^|\/)__tests__\/kunTestActor(\.[cm]?[jt]sx?)?$/]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'",
        "import { kunTestActor } from './utils/__tests__/kunTestActor.ts'",
        "import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor.js'",
        "export { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'"
      ],
      good: [
        "import type { KunActor } from '~/constants/role'",
        "import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'"
      ]
    }
  },
  {
    id: 'inv-server-01',
    aliases: ['T05'],
    statement:
      "不写 'use server' 指令 (文件首行与函数体内都算); 只在服务端被 await 的读取器首行写 import 'server-only'",
    reason:
      "'use server' 不是「仅服务端」标记: 它把模块的每个导出登记成可被直接 POST 的 Server Function, 入参来自客户端, 调用不经页面守卫。全仓的 actions.ts 只被 page / layout 在服务端调用, 带着这个指令等于多出一批没人校验入参的端点",
    removeWhen:
      '出现确实要由客户端调用的 Server Function 时, 把那个文件加进本条的 ignores, 并在函数内自行校验入参与鉴权',
    enforce: {
      kind: 'syntax',
      selectors: ["ExpressionStatement[directive='use server']"]
    },
    examples: {
      file: 'app/kunInvariantExample.ts',
      bad: [
        "'use server'\nexport const load = async () => 1",
        'export const save = async () => {\n  "use server"\n  return 1\n}'
      ],
      good: [
        "import 'server-only'\nexport const load = async () => 1",
        "export const label = 'use server'"
      ]
    }
  },
  {
    id: 'inv-viewer-01',
    aliases: ['T05'],
    statement:
      'Route Handler 与 app/api 下的模块不得导入 server/viewer/fromHeaders、utils/actions 下读请求上下文的 helper 和页面读取器 (app 下的 actions.ts), 请求视角经 server/viewer/fromRequest 建一次后往下传',
    reason:
      'fromHeaders 靠 React cache 让一次渲染共用同一个视角上下文, 而 cache 只在渲染过程中去重: Route Handler 里每调一次都会新建上下文并重新校验会话, 校验带登录会话的续期与清理 (Redis 读写)。app/api 下的 service 同时被路由与页面调用, 自己去取上下文就会落进这条路径, 所以只收调用方传进来的视角。本条只认直接的静态导入: 经别的模块转一手、或用 import() 动态加载, 它看不到',
    removeWhen: 'utils/actions 与 fromHeaders 不再依赖 React cache 去重',
    // Route Handler 与图标 / 站点地图这类元数据路由都不在渲染过程里
    files: [
      'app/api/**',
      'app/**/route.{ts,tsx,js,jsx}',
      'app/**/{opengraph-image,twitter-image,icon,apple-icon,sitemap,robots,manifest}.{ts,tsx,js,jsx}'
    ],
    // 测试要把路由与页面读取器放在一起比
    ignores: ['**/__tests__/**'],
    enforce: {
      kind: 'import',
      sources: [
        /(^|\/)server\/viewer\/fromHeaders(\.[cm]?[jt]sx?)?$/,
        // safeParseSchema 只是 zod 包装, 不读请求
        /(^|\/)utils\/actions\/(?!safeParseSchema(\.[cm]?[jt]sx?)?$)/,
        // 页面读取器内部经 fromHeaders 取上下文; 路由要同样的数据就调它背后的 service
        /^(~\/app\/|\.{1,2}\/)(.*\/)?actions(\.[cm]?[jt]sx?)?$/
      ]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "import { getViewerContext } from '~/server/viewer/fromHeaders'",
        "import { getViewerContext } from '../../server/viewer/fromHeaders.ts'",
        "import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'",
        "import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'",
        "import { kunGetActions } from '~/app/actions'",
        "import { kunGetActions } from '../../tag/[id]/actions'"
      ],
      good: [
        "import { viewerContextFromRequest } from '~/server/viewer/fromRequest'",
        "import { getHomeData } from '~/app/api/home/service'",
        "import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'",
        "import { safeParseSchema } from '~/utils/actions/safeParseSchema'",
        "import type { ViewerContext } from '~/server/viewer/context'"
      ]
    }
  },
  {
    id: 'inv-viewer-02',
    aliases: ['T05'],
    statement:
      '设置 store 写出的 cookie (kun-patch-setting-store|state|data|…) 的名字只许写在 server/viewer/context.ts: 服务端只在这一处读分级设置, 旧版本客户端留下的屏蔽标签副本不读',
    reason:
      '这些 cookie 没有签名。分级设置只能对有效会话采信; 屏蔽列表的权威值在库里, 鉴权时已经加载, 服务端不接受客户端带来的副本 (副本曾被采信, 为此攒下一串先解析后验签、坏值与空值区分、int4 过滤之类的手工守卫)。此前 Route Handler 与页面各有一族 helper 各读一遍, 三次可见性缺陷都是一侧改了另一侧没改 (匿名请求带 kunNsfwEnable=all 曾经 /api 拿到 NSFW 列表 52 天)。再出现第二个读取点, 两边就又得靠注释保持一致。本条按字符串字面量认名字, 防的是顺手再写一个读取点; 把名字拆开拼出来它看不到',
    removeWhen: '服务端不再读设置 store 的 cookie',
    // 全仓执法 (components 下也有服务端组件); 本文件要在说明与样例里写出这个名字
    ignores: ['server/viewer/context.ts', '**/__tests__/**', 'lint/**'],
    enforce: {
      kind: 'syntax',
      selectors: [],
      strings: [/kun-patch-setting-store\|state\|data\|/]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "export const name = 'kun-patch-setting-store|state|data|kunNsfwEnable'",
        'export const read = (cookies: Record<string, string>, key: string) => cookies[`kun-patch-setting-store|state|data|${key}`]'
      ],
      good: [
        "import { viewerContextFromRequest } from '~/server/viewer/fromRequest'",
        "export const storeName = 'kun-patch-setting-store'"
      ]
    }
  },
  {
    id: 'inv-auth-01',
    aliases: ['T07'],
    statement:
      'time2fa 只许在 server/auth/secondFactor.ts 里导入, 其余一律用它导出的 verifySecondFactor / verifyEnrollmentCode / issueBackupCodes / createTotpKey',
    reason:
      'time2fa 的 validate 是纯函数, 只回布尔值: 不登记已用的时间步, 漂移窗口只能逐处传参, 也不计尝试次数。曾有 4 处裸调用, 每处都缺这三样 (同一个码在它的 30 秒内可跨入口重放, 跨步长到达的正确码被拒, 设置页可以无限次猜); 「防 2FA 暴力破解」那次修复改了两个设置页路由, 预算却只接到了登录一处。与本表其它 import 类规则一样, 只认静态导入',
    removeWhen: '全仓不再使用 time2fa',
    // 测试要自己算出真实的验证码
    ignores: ['server/auth/secondFactor.ts', '**/__tests__/**'],
    // 子路径 (time2fa/dist/…) 一并算
    enforce: { kind: 'import', sources: [/^time2fa(\/|$)/] },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "import { Totp } from 'time2fa'",
        "import { generateBackupCodes } from 'time2fa'",
        "export { Hotp } from 'time2fa'",
        "import { Totp } from 'time2fa/dist/index.mjs'"
      ],
      good: [
        "import { verifySecondFactor } from '~/server/auth/secondFactor'",
        "import { toDataURL } from 'qrcode'",
        "import { time } from 'time2fa-like'"
      ]
    }
  },
  {
    id: 'inv-auth-02',
    aliases: ['T07'],
    statement:
      'verifyPassword 只许在 server/auth/** 与登录路由里导入 (具名或整模块命名空间都算); 已登录后要验当前密码的操作走 server/auth/stepUp.ts 的 requireStepUp',
    reason:
      '裸调 verifyPassword 没有尝试预算: 设置页曾有两处, 持会话的人可以无限次猜当前密码, 每次还白耗一轮 argon2。requireStepUp 先预留额度再读凭据、校验, 哪种操作要验密码由它的策略表决定',
    removeWhen: 'verifyPassword 不再从 algorithm 模块导出',
    // app/api/utils/algorithm.ts 是迁移期整模块转出的旧路径; 测试要拿它核对落库的哈希
    ignores: [
      'server/auth/**',
      'app/api/auth/login/route.ts',
      'app/api/utils/algorithm.ts',
      '**/__tests__/**'
    ],
    enforce: {
      kind: 'import',
      // 按文件名认, 相对路径 (../auth/algorithm、./algorithm) 也算; 全仓只有这一个 algorithm 模块
      sources: [/(^|\/)algorithm(\.[cm]?[jt]sx?)?$/],
      importNames: ['verifyPassword', '*']
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "import { verifyPassword } from '~/server/auth/algorithm'",
        "import { hashPassword, verifyPassword } from '~/app/api/utils/algorithm'",
        "import { verifyPassword as check } from '../../server/auth/algorithm.ts'",
        "import { verifyPassword } from '../auth/algorithm'",
        "import { verifyPassword } from './algorithm'",
        "import * as algorithm from '~/server/auth/algorithm'",
        "export * from '~/server/auth/algorithm'"
      ],
      good: [
        "import { hashPassword } from '~/server/auth/algorithm'",
        "import { requireStepUp } from '~/server/auth/stepUp'"
      ]
    }
  },
  {
    id: 'inv-auth-03',
    aliases: ['T07'],
    statement:
      'checkTotp 与 consumeTwoFactorBackupCode 只许在 server/auth/** 与登录第二步的路由里导入; 其余入口验第二因子走 requireStepUp (或 verifySecondFactor / verifyEnrollmentCode)',
    reason:
      '这两个函数只做校验与消费, 不带尝试预算: 登录第二步有自己按 challenge 的预约, 所以直接用它们; 别的入口直接调, 等于又多一个可以无限次猜验证码或备份码的地方 (备份码的消费还要与它授权的变更同一个事务, 见 consumeStepUpBackupCode)',
    removeWhen: '登录第二步也改走带预算的统一入口, 这两个函数不再从模块导出',
    ignores: [
      'server/auth/**',
      'app/api/auth/verify-2fa/route.ts',
      '**/__tests__/**'
    ],
    enforce: {
      kind: 'import',
      sources: [/(^|\/)(secondFactor|twoFactorBackupCode)(\.[cm]?[jt]sx?)?$/],
      importNames: ['checkTotp', 'consumeTwoFactorBackupCode', '*']
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "import { checkTotp } from '~/server/auth/secondFactor'",
        "import { consumeTwoFactorBackupCode } from '~/server/auth/twoFactorBackupCode'",
        "import * as secondFactor from '../../server/auth/secondFactor'",
        "export * from '~/server/auth/twoFactorBackupCode'"
      ],
      good: [
        "import { verifySecondFactor } from '~/server/auth/secondFactor'",
        "import { hashTwoFactorBackupCode } from '~/server/auth/twoFactorBackupCode'",
        "import { secondFactorCodeSchema } from '~/validations/secondFactor'",
        "import { requireStepUp } from '~/server/auth/stepUp'"
      ]
    }
  },
  {
    id: 'inv-auth-04',
    aliases: ['T09'],
    statement:
      'server/auth/** 之外, user 表的 update / updateMany / upsert 写入体必须是行内对象字面量, 里面不得出现凭据与权限列 (password、email、enable_2fa、two_factor_secret、two_factor_backup、role、status、security_stamp), 也不得展开或用计算键; 这些列经 server/auth/securityEvents.ts 的 applyKunCredentialChange 写, 提交之后调 finishKunSecurityEvent',
    reason:
      '「哪个账号事件吊销什么」只写在 KUN_SECURITY_POLICY 一张表里, 安全戳与凭据写在同一条语句里。绕过它直接写凭据, 新的写路径就不刷新戳、不吊销会话 (曾有 4 条安全写路径一个会话都不吊销, 要逐个路由去审); 写入体里的展开 (...rest)、先放进变量的写入体、条件表达式的写入体都能带着 role / status / email 写进去而语法上看不见 (后台编辑用户的 ...rest 曾是唯一的逃逸点), 所以写入体必须是字面量。本条只认 <x>.user.<method>(...) 的形状: 把 delegate 解构出来、raw SQL 看不到',
    removeWhen: '凭据列不再由应用层写入',
    files: [
      'app/**/*.ts',
      'server/**/*.ts',
      'lib/**/*.ts',
      'utils/**/*.ts',
      'scripts/**/*.ts'
    ],
    // migration/ 里是一次性的存量修复脚本 (备份码改存哈希), 不是账号事件
    ignores: ['server/auth/**', '**/__tests__/**'],
    enforce: {
      kind: 'syntax',
      selectors: [
        `${USER_PAYLOAD} > Property${keyIs(`/^(${CREDENTIAL_COLUMNS})$/`)}`,
        `${USER_PAYLOAD} > :matches(SpreadElement, Property[computed=true])`,
        `${USER_UPDATE} > ObjectExpression > Property${keyIs('/^(data|update)$/')}${NOT_INLINE_VALUE}`
      ]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "export const run = (prisma: any) => prisma.user.update({ where: { id: 1 }, data: { password: 'h' } })",
        "export const run = (tx: any) => tx.user.updateMany({ where: { id: 1, email: 'a' }, data: { email: 'b' } })",
        'export const run = (ctx: any) => ctx.tx.user.updateMany({ where: { id: 1 }, data: { role: { set: 2 } } })',
        'export const run = (prisma: any) => prisma.user.update({ where: { id: 1 }, data: { status: 2 } as any })',
        "export const run = (prisma: any) => prisma.user.upsert({ where: { id: 1 }, create: { name: 'x' }, update: { enable_2fa: false } })",
        'export const run = (prisma: any, rest: any) => prisma.user.update({ where: { id: 1 }, data: { name: rest.name, ...rest } })',
        "export const run = (prisma: any, key: string) => prisma.user.update({ where: { id: 1 }, data: { [key]: 'x' } })",
        "export const run = (prisma: any) => prisma.user.update({ where: { id: 1 }, data: { 'two_factor_secret': '' } })",
        'export const run = (prisma: any, h: string) => { const data = { password: h }; return prisma.user.update({ where: { id: 1 }, data }) }',
        "export const run = (prisma: any, flag: boolean) => prisma.user.update({ where: { id: 1 }, data: flag ? { email: 'a' } : { name: 'b' } })"
      ],
      good: [
        "export const run = (prisma: any) => prisma.user.update({ where: { id: 1, status: 0 }, data: { name: 'x' } })",
        'export const run = (prisma: any) => prisma.user.updateMany({ where: { id: 1, role: { lt: 2 } }, data: { moemoepoint: { increment: 1 } } })',
        "export const run = (prisma: any) => prisma.user.create({ data: { name: 'x', email: 'a', password: 'h' } })",
        'export const run = (prisma: any) => prisma.patch.update({ where: { id: 1 }, data: { status: 1 } })',
        "export const run = (prisma: any) => applyKunCredentialChange(prisma, { uid: 1, event: 'password-reset', data: { password: 'h' } })"
      ]
    }
  },
  {
    id: 'inv-auth-05',
    aliases: ['T09'],
    statement:
      'deleteKunToken 与 deleteOtherKunTokenSessions 只许在 server/auth/** 里导入; 账号事件之后的吊销一律经 securityEvents.ts 的 finishKunSecurityEvent, 由策略表决定删哪些会话',
    reason:
      '提交之后逐个删 Redis 键是卫生清理, 吊销是否成立由安全戳决定; 每个写路径各自记得调删键函数, 新路径照样会漏, 而且看不出这个事件该删全部、删其它还是都不删。只登出这一个会话的 deleteKunTokenSession 不在此列。与本表其它 import 类规则一样只认静态导入, import() 动态加载看不到',
    removeWhen: '这两个函数不再从模块导出',
    // app/api/utils/jwt.ts 是迁移期整模块转出的旧路径
    ignores: ['server/auth/**', 'app/api/utils/jwt.ts', '**/__tests__/**'],
    enforce: {
      kind: 'import',
      sources: [/(^|\/)(server\/auth\/session|jwt)(\.[cm]?[jt]sx?)?$/],
      importNames: ['deleteKunToken', 'deleteOtherKunTokenSessions', '*']
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "import { deleteKunToken } from '~/server/auth/session'",
        "import { deleteOtherKunTokenSessions } from '~/app/api/utils/jwt'",
        "import { deleteKunToken as revoke } from '../../server/auth/session.ts'",
        "import * as session from '~/server/auth/session'",
        "export * from '~/app/api/utils/jwt'"
      ],
      good: [
        "import { finishKunSecurityEvent } from '~/server/auth/securityEvents'",
        "import { deleteKunTokenSession } from '~/server/auth/session'",
        "import { resolveKunSiteSession } from '~/server/auth/session'"
      ]
    }
  },
  {
    id: 'inv-route-01',
    aliases: ['T10'],
    statement:
      '导出的 HTTP 方法一律写成 export const <方法> = kunRoute.<同名小写方法>({ ... }): 参数是行内对象字面量, auth、capability、order、form 是字面量; 身份从 handler 的 actor 取, 不再调 verifyHeaderCookie, 声明 public 的 handler 里也不建视角上下文',
    reason:
      '访问级别以前写在 handler 体内, 是一段整段删掉也能通过类型、lint 与测试的语句: 外部抓取五路由匿名可达约 5 个月、@提及搜索约 18 个月, 都靠人工评审才发现; 「调了 verifyHeaderCookie 却不判空」的可选登录与忘了拦截在代码上长得一样。做成入口定义上的必填字面量后, 漏写编译不过, app/api/__tests__/routeManifest.test.ts 才能静态读出全站访问清单',
    removeWhen: 'Route Handler 改由别的、同样带必填访问声明的机制定义',
    files: ['app/**/route.ts'],
    enforce: {
      kind: 'syntax',
      selectors: [
        `ExportNamedDeclaration > FunctionDeclaration[id.name=${HTTP_METHOD}]`,
        `ExportSpecifier[exported.name=${HTTP_METHOD}]`,
        `${ROUTE_EXPORT}:not([init.type='CallExpression'][init.callee.type='MemberExpression'][init.callee.object.name='kunRoute'])`,
        ...HTTP_METHODS.map(
          (method) =>
            `${ROUTE_EXPORT}[id.name='${method}'][init.callee.object.name='kunRoute']:not([init.callee.property.name='${method.toLowerCase()}'])`
        ),
        `${KUN_ROUTE_CALL}:not([arguments.length=1][arguments.0.type='ObjectExpression'])`,
        `${KUN_ROUTE_CALL} > ObjectExpression > :matches(SpreadElement, Property[computed=true])`,
        `${KUN_ROUTE_CALL} > ObjectExpression:not(:has(> Property[key.name='auth']))`,
        `${KUN_ROUTE_CALL} > ObjectExpression > Property[key.name=/^(auth|capability|order|form)$/]:not([value.type='Literal'])`,
        "CallExpression[callee.name='verifyHeaderCookie']",
        // esquery 的 :has 里多级子选择器 (> A > B) 不生效, 要逐级嵌套
        `${KUN_ROUTE_CALL}:has(> ObjectExpression:has(> Property[key.name='auth'][value.value='public'])) CallExpression[callee.name='viewerContextFromRequest']`
      ]
    },
    examples: {
      file: 'app/api/kunInvariantExample/route.ts',
      bad: [
        'export async function GET() { return Response.json({}) }',
        'export const POST = async () => Response.json({})',
        'const handler = kunRoute.get({ auth: "public", handler: async () => ({}) })\nexport { handler as GET }',
        'const handler = kunRoute.get({ auth: "public", handler: async () => ({}) })\nexport const GET = handler',
        'export const POST = kunRoute.get({ auth: "public", handler: async () => ({}) })',
        'export const GET = kunRoute.get(def)',
        'export const GET = kunRoute.get({ ...def })',
        'export const GET = kunRoute.get({ handler: async () => ({}) })',
        'export const GET = kunRoute.get({ auth: level, handler: async () => ({}) })',
        "export const GET = kunRoute.get({ auth: 'user', capability: cap, handler: async () => ({}) })",
        "export const GET = kunRoute.get({ ['auth']: 'public', handler: async () => ({}) })",
        "export const GET = kunRoute.get({ auth: 'optional', handler: async ({ req }) => ({ uid: (await verifyHeaderCookie(req))?.uid }) })",
        "export const GET = kunRoute.get({ auth: 'public', handler: async ({ req }) => viewerContextFromRequest(req).listView() })"
      ],
      good: [
        "export const GET = kunRoute.get({ auth: 'public', handler: async () => ({}) })",
        "export const DELETE = kunRoute.delete({ auth: 'user', capability: 'admin.access', input: schema, handler: async ({ input }) => input })",
        "export const POST = kunRoute.post({ auth: 'user', order: 'auth-first', form: true, input: schema, legacyDeny: { unauthenticated: '用户未认证' }, handler: async () => ({}) })",
        "export const GET = kunRoute.get({ auth: 'optional', handler: async ({ req }) => viewerContextFromRequest(req).listView() })",
        "export const runtime = 'nodejs'\nexport const dynamic = 'force-dynamic'"
      ]
    }
  },
  {
    id: 'inv-tx-01',
    aliases: ['T13'],
    statement:
      '事务一律经 server/db/tx.ts 的 kunTx 开启, 不直接碰 $transaction (调用、取引用、解构都不行)',
    reason:
      'prisma.$transaction 的回调 return 即提交, 而本仓的业务失败是 return 字符串: 回调里顺手 return 一句错误就带着已做的写入提交了 (8289bef4 提交出公开可见的孤儿 patch 行, 63fbe3f2 泄漏永久公开的 S3 对象); 挂在 .catch 上的清理在回调 resolve 时又被整个绕过。kunTx 的回调类型不收字符串, 回滚、有意提交与两种结果之后的动作都由执行器负责',
    removeWhen: '事务不再由 Prisma 的交互式事务承载',
    // 迁移脚本与 scripts/ 是一次性的离线程序, 各自管理事务; 测试要 mock / 直接驱动它
    ignores: [
      'server/db/tx.ts',
      'migration/**',
      'scripts/**',
      '**/__tests__/**'
    ],
    enforce: {
      kind: 'syntax',
      selectors: [
        "MemberExpression[property.name='$transaction']",
        "MemberExpression[property.value='$transaction']",
        "MemberExpression > TemplateLiteral.property:has(TemplateElement[value.raw='$transaction'])",
        "ObjectPattern > Property[key.name='$transaction']",
        "ObjectPattern > Property[key.value='$transaction']"
      ]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        'export const run = (prisma: any) => prisma.$transaction(async (tx: any) => tx.user.count())',
        'export const run = (prisma: any) => prisma.$transaction([prisma.user.count()])',
        'export const run = (tx: any) => tx.$transaction(async (inner: any) => inner.user.count())',
        "export const run = (prisma: any) => prisma['$transaction'](async (tx: any) => tx.user.count())",
        'export const run = (prisma: any) => prisma[`$transaction`](async (tx: any) => tx.user.count())',
        'export const run = (prisma: any) => { const begin = prisma.$transaction; return begin.call(prisma, async (tx: any) => tx.user.count()) }',
        'export const run = (prisma: any) => { const { $transaction } = prisma; return $transaction(async (tx: any) => tx.user.count()) }',
        "export const run = (prisma: any) => { const { ['$transaction']: begin } = prisma; return begin(async (tx: any) => tx.user.count()) }"
      ],
      good: [
        "export const run = () => kunTx('user.count', async ({ tx }) => ({ count: await tx.user.count() }))",
        "export type Itx = Omit<Prisma.TransactionClient, '$transaction'>",
        'export const run = (tx: any, id: number) => tx.$queryRaw`SELECT id FROM "user" WHERE id = ${id} FOR UPDATE`'
      ]
    }
  },
  {
    id: 'inv-fetch-01',
    aliases: ['T16'],
    statement:
      'kunFetch* 的返回值不得以语句形式丢弃; 确实不看结果的请求写成 void kunFetchXxx(...) 并注明原因',
    reason:
      'kunFetch 不抛异常: 断网、非 2xx 与业务拒绝都以字符串返回。把调用写成一条语句就是把失败当成功 (删除评价、删除资源、标签与会社选择器都曾在请求失败后照常提示成功并改动本地状态), 类型系统拦不住这种写法',
    removeWhen:
      'kunFetch 的失败改回异常通道, 或返回值换成不消费就编译不过的类型',
    enforce: {
      kind: 'syntax',
      selectors: [
        `ExpressionStatement > AwaitExpression > ${KUN_FETCH_CALL}`,
        `ExpressionStatement > ${KUN_FETCH_CALL}`
      ]
    },
    examples: {
      file: 'components/kun/KunInvariantExample.tsx',
      bad: [
        "export const run = async () => { await kunFetchPost('/user/status/logout') }",
        "export const run = () => { kunFetchPut('/patch/resource/download', { id: 1 }) }",
        "export const run = async () => { await kunFetchDelete<KunResponse<{}>>('/patch/rating', { id: 1 }) }"
      ],
      good: [
        "export const run = () => { void kunFetchPut('/patch/resource/download', { id: 1 }) }",
        "export const run = async () => { const res = await kunFetchPost('/user/status/logout'); return typeof res === 'string' }",
        "export const run = () => kunFetchGet('/tag/all').then((res) => res)",
        "export const run = async () => { kunErrorHandler(await kunFetchGet('/tag/all'), () => {}) }"
      ]
    }
  },
  {
    id: 'inv-search-01',
    aliases: ['T42'],
    statement:
      'isMeiliEnabled 只许 server/search/failure.ts 导入 (具名或整模块命名空间都算), 要不要走索引由那里的 withMeiliEngine 决定',
    reason:
      '作品列表、标签页、会社页与关键词搜索曾各写一份 `if (isMeiliEnabled()) try { … } catch { 降级 }`, catch 不分错误类别: 请求参数被 Meilisearch 拒绝 (小数页码、带孤立代理的筛选值都是 400) 和写在 try 里的 PG 错误一律当成索引宕机, 匿名请求可以按需把搜索切到最重的 Prisma 路径, 部署漂移 (线上索引定义落后于代码) 也被同一个 catch 悄悄盖住。withMeiliEngine 只对 Meilisearch 自身的故障换引擎, 并让调用方拿到用了哪一个。本条只认静态导入, 拦的是「读开关」这一步: 不读开关、直接调索引查询再自己包 try/catch 的写法由 inv-search-02 管',
    removeWhen: 'Meilisearch 不再是可选后端 (改为必需, 或整体移除)',
    ignores: ['server/search/failure.ts'],
    enforce: {
      kind: 'import',
      // 第二条认相对路径 (lib 目录里的 ./meilisearch); npm 包 meilisearch 是裸说明符, 两条都匹配不到
      sources: [
        /(^|\/)lib\/meilisearch(\.[cm]?[jt]sx?)?$/,
        /^\.{1,2}\/(.*\/)?meilisearch(\.[cm]?[jt]sx?)?$/
      ],
      importNames: ['isMeiliEnabled', '*']
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "import { isMeiliEnabled } from '~/lib/meilisearch'",
        "import { getMeiliClient, isMeiliEnabled as enabled } from '../../lib/meilisearch.ts'",
        "import * as meili from '~/lib/meilisearch'",
        "import { isMeiliEnabled } from './meilisearch'"
      ],
      good: [
        "import { withMeiliEngine } from '~/server/search/failure'",
        "import { getMeiliClient } from '~/lib/meilisearch'",
        "import { Meilisearch } from 'meilisearch'",
        "import * as sdk from 'meilisearch'"
      ]
    }
  },
  {
    id: 'inv-search-02',
    aliases: ['T42'],
    statement:
      'queryGalgameIds 只许登记的调用方导入 (关键词搜索的编排与三个浏览 service), 调用写在 withMeiliEngine 的 meili 回调里',
    reason:
      '索引查询自己不看 KUN_MEILISEARCH_ENABLED (配了引擎就能查), 失败也不分类。新入口直接调它再包一层 try/catch, 就又多出一份不分错误类别的降级, 而且在关掉查询开关的部署上照样去查索引; inv-search-01 只拦得住读开关, 拦不住这种写法。本条按静态导入认, 回调里怎么用它看不到: 新增调用方时把文件加进 ignores, 照现有四处那样经 withMeiliEngine 调用, 卡片经 fetchGalgameCardsByIds 回 PG 取',
    removeWhen:
      'queryGalgameIds 改成只能经 withMeiliEngine 调到 (例如由它把查询函数传进回调)',
    // 测试要直接调它, 也要 mock 它所在的模块
    ignores: [
      'server/galgame/search.ts',
      'app/api/galgame/service.ts',
      'app/api/tag/galgame/service.ts',
      'app/api/company/galgame/service.ts',
      '**/__tests__/**'
    ],
    enforce: {
      kind: 'import',
      // 同目录的相对导入 (server/search 里写 ./query) 不认: 按文件名匹配会撞上别处的 query 模块
      sources: [/(^|\/)server\/search\/query(\.[cm]?[jt]sx?)?$/],
      importNames: ['queryGalgameIds', '*'],
      allowTypeImports: true
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "import { queryGalgameIds } from '~/server/search/query'",
        "import { SEARCH_QUERY_TIMEOUT_MS, queryGalgameIds as query } from '../../server/search/query.ts'",
        "import * as query from '~/server/search/query'"
      ],
      good: [
        "import { searchGalgames } from '~/server/galgame/search'",
        "import { SEARCH_QUERY_TIMEOUT_MS } from '~/server/search/query'",
        "import type { GalgameIndexQuery } from '~/server/search/query'"
      ]
    }
  },
  {
    id: 'inv-search-03',
    aliases: ['T24'],
    statement:
      'Meilisearch 的文档写 API (addDocuments* / updateDocuments* / deleteDocument* / deleteAllDocuments) 只许 server/search/sync.ts 调用, 它的低层应用器 syncPatchToSearch 也不许别处导入: 文档的增删改只经出箱的 drain, 计数只经写锁内的 applyCounts',
    reason:
      '索引是 PG 的派生副本, 它对不对取决于「最后一个写者读到的是最新状态」。曾经有四个写者: drain、对账、全量同步脚本、计数刷新, 各持各的锁或不持锁, 都是先读 PG、过几秒再写; Meilisearch 按入队顺序应用任务、没有条件写, 旧快照后写就会复活已删的游戏、覆盖新标题, 计数刷新的 PUT 还会为索引里没有的 id 建出只有计数的残缺文档。现在活索引只有 sync.ts 一个写者, 它与计数写入共用一把写锁, 对账只检测、只入箱。按成员名认 (调用、取引用、计算属性、解构), 这些名字在仓库里只指 Meilisearch SDK 的方法',
    removeWhen:
      '索引写入改由别的机制保证单写者 (例如 Meilisearch 支持按版本的条件写)',
    ignores: ['server/search/sync.ts', '**/__tests__/**'],
    enforce: {
      kind: 'syntax',
      selectors: [
        `MemberExpression[property.name=${MEILI_DOCUMENT_WRITE}]`,
        `MemberExpression[property.value=${MEILI_DOCUMENT_WRITE}]`,
        `MemberExpression > TemplateLiteral.property:has(TemplateElement[value.raw=${MEILI_DOCUMENT_WRITE}])`,
        `ObjectPattern > Property[key.name=${MEILI_DOCUMENT_WRITE}]`,
        `ObjectPattern > Property[key.value=${MEILI_DOCUMENT_WRITE}]`,
        // 在写锁外调用应用器就是第二个写者
        "ImportSpecifier[imported.name='syncPatchToSearch']",
        "MemberExpression[property.name='syncPatchToSearch']"
      ]
    },
    examples: {
      file: 'scripts/search/kunInvariantExample.ts',
      bad: [
        "import { syncPatchToSearch } from '~/server/search/sync'",
        "import * as sync from '~/server/search/sync'; export const run = () => sync.syncPatchToSearch(1)",
        'export const run = (index: any, docs: any[]) => index.addDocuments(docs).waitTask()',
        'export const run = (index: any, docs: any[]) => index.updateDocuments(docs)',
        'export const run = (index: any) => index.deleteDocuments([1, 2])',
        'export const run = (index: any) => index.deleteDocument(1)',
        'export const run = (index: any) => index.deleteAllDocuments()',
        "export const run = (index: any, docs: any[]) => index['addDocumentsInBatches'](docs, 1000)",
        'export const run = (index: any, docs: any[]) => index[`updateDocumentsInBatches`](docs)',
        'export const run = (index: any, docs: any[]) => { const { addDocuments } = index; return addDocuments(docs) }'
      ],
      good: [
        'export const run = (index: any) => index.getDocuments({ fields: ["id"] })',
        'export const run = (index: any) => index.search("kun")',
        'export const run = () => drainSearchOutbox({ budgetMs: 50000 })',
        'export const run = (tx: any) => tx.patch.deleteMany({ where: { id: 1 } })'
      ]
    }
  },
  {
    id: 'inv-search-04',
    aliases: ['T24'],
    statement:
      '服务端代码里, 建索引、改索引与 settings 的 Meilisearch API (createIndex / updateIndex / deleteIndex / swapIndexes / updateSettings / resetSettings 与逐项的 update* / reset* 设置) 只许 server/search/indexAdmin.ts 调用',
    reason:
      'settings 以前只能手工 pnpm search:init (已删, 现为 search:ensure) 下发, 部署从不调用: 一次上线带着按 releasedSort 排序的代码, 线上索引却一直没有这个可排序字段, 依赖它的查询被拒后降级到 basic 引擎; 下发了 settings 而没重写文档时查询不报错、排序却是错的。现在由 indexAdmin.ts 比对代码里声明的 settings 与线上读数, 按扩张 / 收缩分在部署的切换前后下发。别处再调这些 API, 线上定义就又有了第二个来源。按成员名认 (调用、取引用、计算属性、解构), 不认裸标识符: 客户端有同名的局部函数 resetSettings',
    removeWhen:
      '索引定义改由 Meilisearch 之外的机制下发 (例如引擎自带的声明式配置)',
    // 只管服务端代码: updateSettings / resetSettings 是常见的名字, 客户端 store 里出现它们与
    // Meilisearch 无关, 而管理密钥本来就到不了客户端
    files: ['server/**', 'scripts/**', 'lib/**', 'app/api/**', 'prisma/**'],
    ignores: ['server/search/indexAdmin.ts', '**/__tests__/**'],
    enforce: {
      kind: 'syntax',
      selectors: [
        `MemberExpression[property.name=${MEILI_INDEX_ADMIN}]`,
        `MemberExpression[property.value=${MEILI_INDEX_ADMIN}]`,
        `MemberExpression > TemplateLiteral.property:has(TemplateElement[value.raw=${MEILI_INDEX_ADMIN}])`,
        `ObjectPattern > Property[key.name=${MEILI_INDEX_ADMIN}]`,
        `ObjectPattern > Property[key.value=${MEILI_INDEX_ADMIN}]`
      ]
    },
    examples: {
      file: 'scripts/search/kunInvariantExample.ts',
      bad: [
        "export const run = (client: any) => client.createIndex('galgame', { primaryKey: 'id' })",
        'export const run = (index: any, settings: any) => index.updateSettings(settings).waitTask()',
        "export const run = (index: any) => index.updateSortableAttributes(['id'])",
        'export const run = (index: any) => index.resetSettings()',
        "export const run = (client: any) => client.deleteIndex('galgame')",
        "export const run = (client: any) => client.swapIndexes([{ indexes: ['a', 'b'] }])",
        "export const run = (client: any) => client['updateIndex']('galgame', { primaryKey: 'id' })",
        'export const run = (index: any, settings: any) => { const { updateSettings } = index; return updateSettings(settings) }'
      ],
      good: [
        'export const run = (index: any) => index.getSettings()',
        "export const run = (client: any) => client.getIndex('galgame')",
        "export const run = () => ensureSearchIndex({ mode: 'check' })",
        'export const run = (resetSettings: () => void) => resetSettings()'
      ]
    }
  },
  {
    id: 'inv-cache-01',
    aliases: ['T15'],
    statement:
      '资源族的四个失效 helper (invalidatePatchResourceDetailCache、invalidateResourceListCache、invalidateResourceStatsListCache、invalidateUserPendingResourceCache) 只许 server/cache/** 引用; 写路径在 kunTx 里用 recordKunChanges 报告改了哪一行、前后是什么状态, 失效哪些缓存由 server/cache/plan.ts 决定',
    reason:
      '资源的「公开 / 上架 / 待审」闸门曾在 10 多个处理器里各抄一份, 两天里被点修五次, 抄本之间留下过注释自认恒不成立的分支和过时的理由。规划器把闸门收成一份由表驱动测试覆盖的纯函数; 直接调 helper 就又多出一份闸门。按名字认 (导入、转出、成员访问、解构, 含 import() 的结果), 不按路径: 这四个名字在仓库里只指这四个函数, 而 ./cache 这类相对路径在各目录里指不同的模块。迁移脚本 (migration/、scripts/) 是一次性的批处理, 不在此列',
    removeWhen:
      '这四个 helper 不再从各自的缓存模块导出 (只由 server/cache 持有)',
    ignores: [
      'server/cache/**',
      'migration/**',
      'scripts/**',
      '**/__tests__/**'
    ],
    enforce: {
      kind: 'syntax',
      selectors: [
        `ImportSpecifier[imported.name=${RESOURCE_CACHE_HELPER}]`,
        `ExportSpecifier[local.name=${RESOURCE_CACHE_HELPER}]`,
        `MemberExpression[computed=false][property.name=${RESOURCE_CACHE_HELPER}]`,
        `MemberExpression[computed=true][property.value=${RESOURCE_CACHE_HELPER}]`,
        // 解构: 命名空间对象或 await import(...) 的结果
        `ObjectPattern > Property${keyIs(RESOURCE_CACHE_HELPER)}`
      ]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "import { invalidateResourceListCache } from '~/app/api/resource/cache'",
        "import { invalidatePatchResourceDetailCache } from './cache'",
        "import { invalidateUserPendingResourceCache as drop } from '../utils/pendingResourceCache'",
        "import * as cache from '~/app/api/resource/cache'\nvoid cache.invalidateResourceStatsListCache()",
        "import * as cache from '~/app/api/resource/cache'\nvoid cache['invalidateResourceListCache']()",
        "import * as cache from '~/app/api/resource/cache'\nconst { invalidateResourceListCache } = cache",
        "const { invalidatePatchResourceDetailCache: drop } = await import('~/app/api/patch/resource/cache')",
        "export { invalidateResourceStatsListCache } from '~/app/api/resource/cache'"
      ],
      good: [
        "import { recordKunChanges } from '~/server/cache/publish'",
        "import { getResourceListCacheKey } from '~/app/api/resource/cache'",
        "import * as cache from '~/app/api/resource/cache'\nvoid cache.getResourceListCacheKey"
      ]
    }
  },
  {
    id: 'inv-list-01',
    aliases: ['T17'],
    statement:
      '组件里不得再手写列表取数的生命周期: 不新声明 *RequestIdRef 守卫, 不自己 new IntersectionObserver 做加载哨兵 (改用 hooks/useKunPagedList、useKunInfiniteList、useKunKeyedQuery, 规则在 utils/list/kunListMachine.ts); 不把服务端实体的 isLike / likeCount 复制进叶子组件的 useState (由持有列表的组件拥有, 叶子组件受控)',
    reason:
      '「只让最新请求落地、写后刷新取当前查询、越界钳制、失败即停、追加去重、删行退页或补齐」这些规则曾在 30 多个容器里各抄一份, 没有 DOM 测试只能用源码正则守拼写; 兄弟副本只抄到一部分, 缺陷就按副本数复现 (P22-02、P28-01、P29-03/05、P23-02)。复制进 useState 的点赞字段不回写列表, 重新挂载即回退成旧值, 再点一次服务端执行的是取消点赞 (D09-01)。存量的手写副本记在 eslint-suppressions.json 基线里, 迁走一个删一条',
    removeWhen:
      '列表取数换成别的机制 (例如引入 DOM 测试后改用跨挂载缓存), 或这三个 hook 被删除',
    files: ['components/**', 'app/**'],
    // 目录页的滚动高亮也用 IntersectionObserver, 与列表加载无关
    ignores: ['components/doc/TableOfContents.tsx', '**/__tests__/**'],
    enforce: {
      kind: 'syntax',
      // 名字不分大小写 (requestIdRef 也算); new window.IntersectionObserver 也算; useState 的
      // 初值认 x.isLike、x?.isLike 与解构出来的 isLike, React.useState 也算
      selectors: [
        'VariableDeclarator[id.name=/requestidref$/i]',
        "NewExpression:matches([callee.name='IntersectionObserver'], [callee.property.name='IntersectionObserver'])",
        `${USE_STATE_CALL} > MemberExpression.arguments[property.name=${LIKE_FIELD}]`,
        `${USE_STATE_CALL} > ChainExpression.arguments > MemberExpression[property.name=${LIKE_FIELD}]`,
        `${USE_STATE_CALL} > Identifier.arguments[name=${LIKE_FIELD}]`
      ]
    },
    examples: {
      file: 'components/kun/KunInvariantExample.tsx',
      bad: [
        'export const C = () => { const latestFetchRequestIdRef = useRef(0); return latestFetchRequestIdRef }',
        'export const C = () => { const latestSearchRequestIdRef = useRef(0); return latestSearchRequestIdRef }',
        'export const C = () => { useEffect(() => { const o = new IntersectionObserver(() => {}); return () => o.disconnect() }, []) }',
        'export const C = () => { const requestIdRef = useRef(0); return requestIdRef }',
        'export const C = () => { useEffect(() => { const o = new window.IntersectionObserver(() => {}); return () => o.disconnect() }, []) }',
        'export const C = ({ resource }) => { const [liked] = useState(resource.isLike); return liked }',
        'export const C = ({ rating }) => { const [count] = useState(rating.likeCount); return count }',
        'export const C = ({ resource }) => { const [liked] = useState(resource?.isLike); return liked }',
        'export const C = ({ resource }) => { const [liked] = React.useState(resource.isLike); return liked }',
        'export const C = ({ isLike }) => { const [liked] = useState(isLike); return liked }'
      ],
      good: [
        'export const C = () => useKunPagedList({ query: { page: 1, limit: 30 }, getId: (item) => item.id, fetchPage })',
        'export const C = () => { const scrolledRatingIdRef = useRef(null); return scrolledRatingIdRef }',
        'export const C = ({ isLike }) => { const [loading] = useState(false); return isLike && loading }',
        'export const C = ({ resource }) => resource.likeCount',
        'export const C = ({ isLike }) => { const [liked, setLiked] = useState(false); return isLike || liked || setLiked }'
      ]
    }
  },
  {
    id: 'inv-identity-02',
    aliases: ['T18'],
    statement:
      'server/identity/** 之外, user 表的读查询 (findFirst / findUnique / findMany / count 等) 与按唯一键定位一行的 update / upsert / delete 不得按 name 或 email 精确匹配 (值不是 contains / startsWith / endsWith 的模糊搜索); 改调 server/identity/lookup.ts',
    reason:
      '同一批 9 个路由 4 个月里被点修 5 次, 每次只修一份副本。精确匹配找人或查重的口径 (lower(列) = lower(输入)、走 lower() 唯一索引、排除自身、按种类只查一列) 只写在 lookup 一处, 与库里的 lower() 唯一索引 (迁移 0018) 是同一个判定。路由里再写一条 findUnique({ where: { email } }) 就是第三种口径: 改邮箱与管理端改号曾用大小写敏感的精确匹配, 放行别人邮箱的大小写变体。模糊搜索 (@ 提及、后台按名搜索) 不在此列。只认 <x>.user.<method>(...) 的行内 where 顶层与 AND / OR / NOT 里的条件; 把 where 先放进变量、展开或解构 delegate 看不到; 原生 SQL 也看不到',
    removeWhen: 'user 表不再以 name / email 作登录标识符',
    // email-notice/disable 按退订令牌里存的原值回查, 不是用户输入; migrateReservedUsernames
    // 是人工执行的一次性改名脚本, 按存量原值精确定位
    ignores: [
      'server/identity/**',
      '**/__tests__/**',
      'app/api/auth/email-notice/disable/route.ts',
      'scripts/migrateReservedUsernames.ts'
    ],
    enforce: {
      kind: 'syntax',
      // 值不是对象 (字面量、变量、简写、函数调用) 即精确匹配; 是对象时看操作名
      selectors: USER_WHERE_IDENTIFIERS.flatMap((identifier) => [
        `${identifier}:not([value.type='ObjectExpression'])`,
        `${identifier} > ObjectExpression > Property${keyIs('/^(equals|in)$/')}`
      ])
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        'export const run = (prisma: any, email: string) => prisma.user.findUnique({ where: { email }, select: { id: true } })',
        "export const run = (prisma: any, name: string) => prisma.user.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, id: { not: 1 } } })",
        'export const run = (tx: any, v: string) => tx.user.findFirst({ where: { OR: [{ email: v }, { name: v }] } })',
        "export const run = (ctx: any) => ctx.tx.user.count({ where: { 'email': 'a@b.c' } })",
        'export const run = (prisma: any, names: string[]) => prisma.user.findMany({ where: { name: { in: names } } })',
        "export const run = (prisma: any, e: string) => prisma.user.update({ where: { email: e }, data: { name: 'x' } })",
        'export const run = (prisma: any, v: string) => prisma.user.delete({ where: { name: v } })',
        'export const run = (prisma: any, v: string) => prisma.user.findFirst({ where: { NOT: { id: 1 }, AND: [{ OR: [{ email: v }] }] } })'
      ],
      good: [
        "export const run = (prisma: any, q: string) => prisma.user.findMany({ where: { name: { contains: q, mode: 'insensitive' } } })",
        'export const run = (prisma: any) => prisma.user.findUnique({ where: { id: 1 }, select: { name: true, email: true } })',
        "export const run = (prisma: any) => prisma.patch_tag.findFirst({ where: { name: 'x' } })",
        "export const run = (tx: any) => tx.user.updateMany({ where: { id: 1, email: 'a' }, data: { name: 'b' } })",
        "export const run = (prisma: any) => prisma.user.findMany({ where: { patch: { some: { name: 'x' } } } })",
        "export const run = () => isEmailTaken('a@b.c', { exceptUid: null })"
      ]
    }
  },
  {
    id: 'inv-value-01',
    aliases: ['T27'],
    statement:
      '数值入参不直接写 z.coerce.number, 改用 validations/primitives.ts 的 kunId / kunPage / kunLimit / kunInt, 确实要小数的用 kunNumber',
    reason:
      'z.coerce.number 默认放行小数, 而 Prisma 把 Int 字段上的 5.5 静默截成 5: 守卫、Redis 键与 raw SQL 的 ::int 拿的是原值, 落库的是截断值 (小数 uid 绕过「不能关注自己」「请勿删除自己」)。158 条手写链里只有 9 条带 .int(), 每次点修都没有传播到同文件的下一行。原语把整数性、int4 上界与中文文案放在一处。认 <任意命名空间>.coerce.number 与 coerce.number (调用或取出来都算, 计算键也算) 以及从 coerce 里解构出 number; 先把 z.coerce 存进别名变量再取 .number 看不到',
    removeWhen: 'zod 的 coerce.number 默认拒绝小数, 或入参不再经 zod 校验',
    ignores: ['validations/primitives.ts', '**/__tests__/**'],
    enforce: {
      kind: 'syntax',
      selectors: [
        `MemberExpression:matches([computed=false][property.name='number'], [property.value='number']):matches(${COERCE_OBJECT})`,
        `VariableDeclarator:matches(${COERCE_INIT}) > ObjectPattern > Property${keyIs("'number'")}`
      ]
    },
    examples: {
      file: 'validations/kunInvariantExample.ts',
      bad: [
        "import * as z from 'zod'\nexport const s = z.object({ id: z.coerce.number().min(1).max(9999999) })",
        "import * as z from 'zod'\nexport const s = z.coerce.number<number>({ message: 'x' }).int()",
        "import * as z from 'zod'\nconst make = z.coerce.number\nexport const s = make()",
        "import * as zod from 'zod'\nexport const s = zod.coerce.number()",
        "import * as z from 'zod'\nexport const s = z.coerce['number']()",
        "import * as z from 'zod'\nexport const s = z['coerce'].number()",
        "import { coerce } from 'zod'\nexport const s = coerce.number()",
        "import * as z from 'zod'\nconst { number } = z.coerce\nexport const s = number()"
      ],
      good: [
        "import * as z from 'zod'\nimport { kunId } from './primitives'\nexport const s = z.object({ id: kunId('评论 ID') })",
        "import * as z from 'zod'\nexport const s = z.coerce.boolean()",
        "import * as z from 'zod'\nexport const s = z.number().int()",
        "import * as z from 'zod'\nconst { boolean } = z.coerce\nexport const s = boolean()",
        'export const n = (x: { coerce: { numbers: () => number } }) => x.coerce.numbers()'
      ]
    }
  },
  {
    id: 'inv-status-01',
    aliases: ['T29'],
    statement:
      'status 不写一位数的数字字面量 (对象键 status 的值、status 过滤条件里的值、与 .status 的相等比较、SQL 文本里的 status 比较): 评论、评价、资源用 constants/contentStatus.ts 的常量与 contentPhase, 判能否看、能否操作用 utils/content/policy.ts 与 server/content/visibility.ts; 别的表 (举报、用户、私信、反馈、创作者申请) 的 status 还没有常量, 存量记在 eslint-suppressions.json 基线里, 只减不增',
    reason:
      '三张内容表的 status 是无约束 Int, 编码按表错位 (评论 / 评价 1 待审 2 隐藏, 资源 1 隐藏 2 待初审 3 待审)。裸数字之上的规则曾在 12 个闸门、3 个可见性构造器和 13 个组件里各抄一份: 810ff0a8 新增资源 3 时靠对抗审查才找出 4 处旧判断, 还漏了发布弹窗一处 (P26-04); 兄弟路径各少一道判断的点修出过 5 次。认不出值从变量传进来的写法 (那几处已改用迁移表)',
    removeWhen:
      'status 改成 PG / Prisma enum 或 text 列, 或内容状态拆成独立的审核列与可见性列',
    // lint/ 自己的样例串会被 strings 命中
    ignores: ['constants/contentStatus.ts', 'lint/**', '**/__tests__/**'],
    enforce: {
      kind: 'syntax',
      selectors: [
        `Property${keyIs("'status'")} > Literal.value[raw=/^[0-9]$/]`,
        // 三元的分支值, 嵌套的三元也算 (status: a ? 2 : b ? 3 : 0)
        `Property${keyIs("'status'")} > ConditionalExpression :matches(Literal.consequent, Literal.alternate)[raw=/^[0-9]$/]`,
        `Property${keyIs("'status'")} > ObjectExpression > Property > Literal.value[raw=/^[0-9]$/]`,
        `Property${keyIs("'status'")} > ObjectExpression > Property > ArrayExpression > Literal[raw=/^[0-9]$/]`,
        "BinaryExpression[operator=/^[!=]==?$/]:matches([left.property.name='status'], [left.expression.property.name='status']) > Literal.right[raw=/^[0-9]$/]",
        "BinaryExpression[operator=/^[!=]==?$/]:matches([right.property.name='status'], [right.expression.property.name='status']) > Literal.left[raw=/^[0-9]$/]"
      ],
      strings: [/\bstatus\s*(=|<>|!=|\bIN\b)\s*\(?\s*[0-9]\b/i]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        'export const w = { status: 0 }',
        'export const w = { patch_id: 1, status: { in: [0, 1] } }',
        'export const w = { status: { not: 2 } }',
        'export const d = (intercept: boolean) => ({ status: intercept ? 1 : 0 })',
        'export const d = (a: boolean, b: boolean) => ({ status: a ? RESOURCE_STATUS.awaitingApproval : b ? 3 : RESOURCE_STATUS.public })',
        'export const f = (r: { status: number }) => r.status === 1',
        'export const f = (r: { status: number }) => 2 !== r.status',
        'export const f = (r?: { status: number }) => r?.status === 3',
        'export const q = `SELECT id FROM patch_comment WHERE status = 0`',
        'export const q = `WHERE status IN (0, 1) AND user_id = ${1}`'
      ],
      good: [
        "import { COMMENT_STATUS } from '~/constants/contentStatus'\nexport const w = { status: COMMENT_STATUS.public }",
        "import { contentPhase, isPendingPhase } from '~/constants/contentStatus'\nexport const f = (r: { status: number }) => isPendingPhase(contentPhase('resource', r.status))",
        "export const s = { status: 'pending' }",
        'export const f = (r: Response) => r.status === 401',
        'export const init = { status: 502 }',
        'export const w = { avatar_status: 0 }'
      ]
    }
  }
]

const formatMessage = (/** @type {KunInvariant} */ inv) =>
  `${inv.id}${inv.aliases?.length ? `（${inv.aliases.join('、')}）` : ''}：${inv.statement}。理由：${inv.reason}；移除条件：${inv.removeWhen}`

// 成员名可以是标识符, 也可以是字符串字面量 (import { 'a-b' as x })
const nameOf = (node) => node?.name ?? node?.value

const importedName = (specifier) =>
  specifier.type === 'ImportDefaultSpecifier'
    ? 'default'
    : specifier.type === 'ImportNamespaceSpecifier'
      ? '*'
      : nameOf(specifier.imported ?? specifier.local)

// 只用 context.report 与 selector 两个稳定 API。import 类与核心 no-restricted-imports
// 一样不检查 ImportExpression, 所以「只许经 import() 懒加载」可以直接表达
/** @type {(inv: KunInvariant) => import('eslint').Rule.RuleModule} */
export const createKunInvariantRule = (inv) => ({
  meta: { type: 'problem', schema: [] },
  create(context) {
    const message = formatMessage(inv)
    const report = (node) => context.report({ node, message })
    const { enforce } = inv
    if (enforce.kind === 'syntax') {
      const handlers = Object.fromEntries(
        enforce.selectors.map((selector) => [selector, report])
      )
      if (enforce.strings) {
        // 键写成 :matches(...), 不会与 selectors 里同名的 'Literal' 之类互相覆盖
        handlers[':matches(Literal, TemplateLiteral)'] = (node) => {
          const text =
            node.type === 'TemplateLiteral'
              ? node.quasis
                  .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
                  .join('$1')
              : node.value
          if (
            typeof text === 'string' &&
            enforce.strings.some((pattern) => text.search(pattern) !== -1)
          ) {
            report(node)
          }
        }
      }
      return handlers
    }

    const check = (node) => {
      const source = node.source?.value
      const matched = enforce.sources.some((candidate) =>
        typeof candidate === 'string'
          ? candidate === source
          : // search 不读写 lastIndex, 带 g / y 标志的正则也不会跨调用带状态
            typeof source === 'string' && source.search(candidate) !== -1
      )
      if (!matched) {
        return
      }
      const specifiers = node.specifiers ?? []
      // 整句 `import type` 与全部成员都带 type 的行内写法都会被编译器整句擦除
      const isTypeOnly =
        (node.importKind ?? node.exportKind) === 'type' ||
        (specifiers.length > 0 &&
          specifiers.every(
            (specifier) =>
              (specifier.importKind ?? specifier.exportKind) === 'type'
          ))
      if (enforce.allowTypeImports && isTypeOnly) {
        return
      }
      // 只禁部分成员时: `export * from` 会把被禁成员一并转出去, 照报;
      // `import * as ns` 不报 —— 命名空间导入正是 C9 要求的写法
      if (
        enforce.importNames &&
        node.type !== 'ExportAllDeclaration' &&
        !specifiers.some((specifier) =>
          enforce.importNames.includes(importedName(specifier))
        )
      ) {
        return
      }
      report(node)
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: (node) => node.source && check(node),
      ExportAllDeclaration: check
    }
  }
})

export const kunInvariantPlugin = {
  meta: { name: 'kun' },
  rules: Object.fromEntries(
    KUN_INVARIANTS.map((inv) => [inv.id, createKunInvariantRule(inv)])
  )
}

export const kunInvariantConfigs = () =>
  KUN_INVARIANTS.map((inv) => ({
    ...(inv.files ? { files: inv.files } : {}),
    ...(inv.ignores ? { ignores: inv.ignores } : {}),
    plugins: { kun: kunInvariantPlugin },
    rules: { [`kun/${inv.id}`]: 'error' }
  }))
