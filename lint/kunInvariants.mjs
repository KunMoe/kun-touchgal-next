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
      '断言目标类型里出现 KunActor 的 as / <> 断言只许出现在 verifyAndLoadUser 与测试 helper 里',
    reason:
      'KunActor 的品牌只存在于编译期, 代表「会话已校验、角色取自库里」; 随手断言等于把未校验的 payload 放行到所有按 KunActor 收参的权限判断',
    removeWhen: 'KunActor 品牌被移除',
    // 构造点: 会话校验后从库里取角色的唯一入口, 以及测试用的 actor 工厂
    ignores: [
      'app/api/utils/jwt.ts',
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
      '对象字面量里展开之后不得再写 role 键; 构造 KunActor 只许在 verifyAndLoadUser 里',
    reason:
      '{ ...actor, role: 4 } 不需要断言就能得到带品牌的 KunActor (展开保留品牌, TS 不拦), 角色被换掉而 inv-authz-02 看不到',
    removeWhen: 'KunActor 品牌被移除, 或改为不可展开的类实例',
    // KunActor 只在服务端流动; 客户端的表单与 store 更新 ({ ...user, role }) 与它无关
    files: ['app/**', 'server/**', 'middleware/**', 'utils/**', 'lib/**'],
    // 测试的输入夹具常写 { ...baseInput, role: 2 }; 测试要的 actor 走 __tests__/kunTestActor.ts
    ignores: ['app/api/utils/jwt.ts', '**/__tests__/**'],
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
    // app/api/utils/twoFactorBackupCode.ts 是迁移期整模块转出的旧路径
    ignores: [
      'server/auth/**',
      'app/api/auth/verify-2fa/route.ts',
      'app/api/utils/twoFactorBackupCode.ts',
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
        "import { consumeTwoFactorBackupCode } from '~/app/api/utils/twoFactorBackupCode'",
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
