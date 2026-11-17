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

// delegate 一旦离开 `<obj>.<delegate>.<method>(...)` 的形状 (解构、别名、计算属性访问、当参数传走、
// 把方法取下来另调), 调用点上就没有方法名, 按方法名写的选择器看不到。所以直接报引用本身, 读也算。
// 只放行两种父节点: 被调用的非计算成员; methods 以外的非计算成员 (findMany、count …, 取值不调用也行,
// 如测试里的 vi.mocked(tx.patch_comment.findMany))。_count.patch_resource 是关系计数, 不是 delegate
const detachedContentDelegate = (methods) => [
  `MemberExpression[computed=true]:matches([property.value=${CONTENT_DELEGATE}], [property.quasis.0.value.cooked=${CONTENT_DELEGATE}])`,
  `ObjectPattern > Property:matches([key.name=${CONTENT_DELEGATE}], [key.value=${CONTENT_DELEGATE}])`,
  `MemberExpression[computed=false][property.name=${CONTENT_DELEGATE}]:not([object.property.name='_count'], [object.name='_count'], CallExpression > MemberExpression.callee[computed=false] > MemberExpression.object, MemberExpression[computed=false][property.name!=/^(${methods})$/] > MemberExpression.object)`
]

// raw SQL 里的三张内容表: 可带 schema 前缀与双引号; 表名后不得紧挨标识符字符, 不误伤
// patch_rating_stat、patch_resource_link 这类同前缀的表
const CONTENT_TABLE = String.raw`(?:"?\w+"?\.)?"?patch_(?:comment|rating|resource)\b"?`
// SET 列表到 WHERE / RETURNING 为止: 只在条件或返回列里出现的 status 不算写
const SET_STATUS = String.raw`SET\b(?:(?!\b(?:WHERE|RETURNING)\b)[\s\S])*?\bstatus\b`

// update* 的写入体在 data, upsert 的在 update。upsert 的 create 与 create() 一样是插入时的初始状态
// (评论、评价、资源的创建入口都在 server/content 之外写初始 status), 不归本条管
const CONTENT_UPDATE = `CallExpression[callee.property.name=/^(${CONTENT_UPDATE_METHODS})$/][callee.object.property.name=${CONTENT_DELEGATE}]`
const PAYLOAD_KEY =
  ':matches([key.name=/^(data|update)$/], [key.value=/^(data|update)$/])'
const PAYLOAD = `${CONTENT_UPDATE} > ObjectExpression > Property${PAYLOAD_KEY} > ObjectExpression`

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
    ignores: ['server/content/**'],
    enforce: {
      kind: 'syntax',
      selectors: [
        `CallExpression[callee.property.name=/^(delete|deleteMany)$/][callee.object.property.name=${CONTENT_DELEGATE}]`,
        ...detachedContentDelegate('delete|deleteMany')
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
        'export const run = (tx: any) => { const comments = tx.patch_comment; return comments.delete({ where: { id: 1 } }) }',
        "export const run = (tx: any) => tx['patch_comment'].delete({ where: { id: 1 } })",
        'export const run = (tx: any) => tx[`patch_rating`].deleteMany({ where: { id: 1 } })',
        'export const run = (tx: any) => purgeAll(tx.patch_resource)',
        "export const run = (tx: any) => tx.patch_comment['delete']({ where: { id: 1 } })",
        'export const run = (tx: any) => { const remove = tx.patch_comment.delete; return remove({ where: { id: 1 } }) }',
        'export const run = (tx: any, id: number) => tx.$executeRaw`DELETE FROM patch_comment WHERE id = ${id}`',
        'export const run = (tx: any, id: number) => tx.$executeRawUnsafe(\'delete from only "public"."patch_resource" where id = $1\', id)',
        'export const run = (tx: any) => tx.$executeRaw`TRUNCATE patch_report, patch_rating`'
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
        "export const message = '正文过长, truncate 后再写回 patch_comment'"
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
    ignores: ['server/content/**'],
    // 写入体必须让 status 键字面可见: 实参与写入体都是行内对象字面量, 不许计算键; 展开只许展开两支都是
    // 对象字面量的三元, 被展开的字面量里不再嵌套展开或计算键
    enforce: {
      kind: 'syntax',
      selectors: [
        `${PAYLOAD} Property:matches([key.name='status'], [key.value='status'])`,
        `${CONTENT_UPDATE}:not([arguments.0.type='ObjectExpression'])`,
        `${CONTENT_UPDATE} > ObjectExpression > :matches(SpreadElement, Property[computed=true])`,
        `${CONTENT_UPDATE} > ObjectExpression > Property${PAYLOAD_KEY}:not([value.type='ObjectExpression'])`,
        `${PAYLOAD} > Property[computed=true]`,
        `${PAYLOAD} > SpreadElement:not([argument.type='ConditionalExpression'][argument.consequent.type='ObjectExpression'][argument.alternate.type='ObjectExpression'])`,
        `${PAYLOAD} > SpreadElement ObjectExpression > :matches(SpreadElement, Property[computed=true])`,
        ...detachedContentDelegate(CONTENT_UPDATE_METHODS)
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
        'export const run = (id: number) => Prisma.sql`INSERT INTO patch_comment (id, status) VALUES (${id}, 1) ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`'
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
        'export const run = (tx: any, s: number, id: number) => tx.$executeRaw`UPDATE patch_rating_like SET status = ${s} WHERE id = ${id}`'
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
