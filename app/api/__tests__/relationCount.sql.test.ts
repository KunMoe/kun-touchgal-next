import { globSync, readdirSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expectAggregatePushdown,
  wholeTableAggregates
} from '~/prisma/__tests__/support/sqlShape'

// 列表里的关系 _count 依赖的编译器输出, 不连库。Prisma 把关系 _count 编译成对子表的
// 聚合子查询, 外层的条件下推不进去; 各站点靠一个「对返回行恒真」的关系过滤 (源码里标着
// 「勿删」) 让聚合带上条件。各站点自己的单测只锁得住传给 Prisma 的参数, 这里看的是
// 编译出来的 SQL 里聚合子查询到底带没带条件。
//
// 每条用例同时钉住这次查询里「整表聚合」的全集 (wholeTable): 在这些查询上再加一个不带
// 过滤的 _count 会红。文件末尾的两张登记表再把范围扩到全仓的源码: 写下关系 _count 的文件
// 与导出的共享参数对象都要登记, 列表查询要在这里有驱动它的用例 (它看不到什么, 写在表的上方)

const { recorder, verifyHeaderCookieMock } = await vi.hoisted(async () => ({
  recorder: (
    await import('~/prisma/__tests__/support/sqlRecorder')
  ).createSqlRecorder(),
  verifyHeaderCookieMock: vi.fn()
}))

vi.mock('~/prisma/index', () => recorder.module)

// 关注与粉丝列表的查询写在路由文件里, 只能经路由驱动
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

// 直通缓存层: 这里只看查询
vi.mock('~/app/api/patch/comment/cache', () => ({
  withPatchCommentPageCache: (
    _patchId: number,
    _resourceId: number | null,
    _page: number,
    _limit: number,
    query: () => Promise<unknown>
  ) => query()
}))

vi.mock('~/app/api/patch/resource/cache', () => ({
  getPatchResourceDetailCacheKey: async () => null,
  getCachedPatchResourceDetail: async () => ({
    response: null,
    canWrite: false
  })
}))

vi.mock('~/app/api/resource/cache', () => ({
  getResourceListCacheKey: async () => null,
  getCachedResourceList: async () => ({ response: null, canWrite: false })
}))

import { getComment as getAdminComment } from '~/app/api/admin/comment/get'
import { getAdminCreator } from '~/app/api/admin/creator/service'
import { getRating as getAdminRating } from '~/app/api/admin/rating/get'
import { getPatchResource as getAdminResource } from '~/app/api/admin/resource/get'
import { getUserInfo as getAdminUser } from '~/app/api/admin/user/get'
import { getHomeData } from '~/app/api/home/service'
import { getPatchComment } from '~/app/api/patch/comment/get'
import { getPatchRating } from '~/app/api/patch/rating/get'
import { getPatchResource } from '~/app/api/patch/resource/get'
import { getPatchResource as getResourceList } from '~/app/api/resource/service'
import { GET as getFollowerRoute } from '~/app/api/user/follow/follower/route'
import { GET as getFollowingRoute } from '~/app/api/user/follow/following/route'
import { getUserComment } from '~/app/api/user/profile/comment/service'
import { getFolders } from '~/app/api/user/profile/favorite/folder/get'
import { getUserPatchRating } from '~/app/api/user/profile/rating/service'
import type { ListView } from '~/server/viewer/patchVisibility'

const PATCH_ID = 9
const USER_ID = 7
const guest = { uid: 0, role: 0 }
// 看得到待审核内容的视角不走共享缓存, 是另一处调用
const moderator = { uid: 5, role: 3 }
const page = { page: 1, limit: 10 }
// 带屏蔽标签的视角不读写共享缓存, 直接查询
const filteredView: ListView = {
  kind: 'filtered',
  visibility: { contentLimit: 'sfw', blockedTagIds: [3] }
}

const followListRequest = new Request(
  `http://localhost/?uid=${USER_ID}&page=1&limit=10`
) as unknown as Parameters<typeof getFollowerRoute>[0]

const commentLikes = {
  relationTable: 'user_patch_comment_like_relation',
  parentTable: 'patch_comment'
}
const ratingLikes = {
  relationTable: 'patch_rating_like',
  parentTable: 'patch_rating'
}
const resourceLikes = {
  relationTable: 'user_patch_resource_like_relation',
  parentTable: 'patch_resource'
}

const pushdownCases = [
  {
    site: '评论列表',
    file: 'app/api/patch/comment/get.ts',
    run: () => getPatchComment({ patchId: PATCH_ID, ...page }, guest),
    pushdown: { ...commentLikes, predicateColumn: 'patch_id' },
    wholeTable: []
  },
  {
    site: '评价列表',
    file: 'app/api/patch/rating/get.ts',
    run: () =>
      getPatchRating(
        { patchId: PATCH_ID, ...page, onlyWithShortSummary: false },
        guest
      ),
    pushdown: { ...ratingLikes, predicateColumn: 'patch_id' },
    wholeTable: []
  },
  {
    // 上传者的资源总数没有可下推的条件, C15 裁定保留
    site: '资源 tab (公开视角)',
    file: 'app/api/patch/resource/get.ts',
    run: () => getPatchResource({ patchId: PATCH_ID }, null),
    pushdown: { ...resourceLikes, predicateColumn: 'patch_id' },
    wholeTable: ['patch_resource']
  },
  {
    site: '资源 tab (可见待审核内容的视角)',
    file: 'app/api/patch/resource/get.ts',
    run: () => getPatchResource({ patchId: PATCH_ID }, moderator),
    pushdown: { ...resourceLikes, predicateColumn: 'patch_id' },
    wholeTable: ['patch_resource']
  },
  {
    site: '用户主页的评论',
    file: 'app/api/user/profile/comment/service.ts',
    run: () => getUserComment({ uid: USER_ID, ...page }, guest),
    pushdown: { ...commentLikes, predicateColumn: 'user_id' },
    wholeTable: []
  },
  {
    site: '用户主页的评价',
    file: 'app/api/user/profile/rating/service.ts',
    run: () => getUserPatchRating({ uid: USER_ID, ...page }, guest),
    pushdown: { ...ratingLikes, predicateColumn: 'user_id' },
    wholeTable: []
  },
  {
    site: '收藏夹列表',
    file: 'app/api/user/profile/favorite/folder/get.ts',
    run: () => getFolders({ patchId: PATCH_ID }, USER_ID, USER_ID),
    pushdown: {
      relationTable: 'user_patch_favorite_folder_relation',
      parentTable: 'user_patch_favorite_folder',
      predicateColumn: 'user_id'
    },
    wholeTable: []
  }
]

// 这些列表的关系 _count 没有被父表的键限定, 每次查询都把所列的表整个 GROUP BY 一遍。登记
// 在这里是为了让它成为看得见的状态: 修掉一处 (聚合带上父表的键、改读计数列) 之后这里会红,
// 把那一项删掉; 给这些查询再加一个也会红。只在子表自己的列上加条件 (比如只数 status 为 0
// 的) 不算修掉, 那一项不会消失。后台五处还没有裁定; 前台五处在 C15 裁定过保留或不做
const wholeTableCases = [
  {
    site: '后台评论列表的点赞数',
    file: 'app/api/admin/comment/get.ts',
    run: () => getAdminComment({ ...page, searchType: 'content' }),
    wholeTable: ['user_patch_comment_like_relation']
  },
  {
    site: '后台评价列表的点赞数',
    file: 'app/api/admin/rating/get.ts',
    run: () => getAdminRating({ ...page, searchType: 'content' }),
    wholeTable: ['patch_rating_like']
  },
  {
    site: '后台资源列表的上传者资源数',
    file: 'app/api/admin/resource/get.ts',
    run: () => getAdminResource({ ...page, searchType: 'content' }, null),
    wholeTable: ['patch_resource']
  },
  {
    site: '后台用户列表的资源数与 Galgame 数',
    file: 'app/api/admin/user/get.ts',
    run: () => getAdminUser({ ...page, searchType: 'name' }),
    wholeTable: ['patch_resource', 'patch']
  },
  {
    site: '后台创作者申请列表的申请人资源数',
    file: 'app/api/admin/creator/service.ts',
    run: () => getAdminCreator(page),
    wholeTable: ['patch_resource']
  },
  {
    site: '首页最新资源的上传者资源数',
    file: 'app/api/home/service.ts',
    run: () => getHomeData(filteredView),
    wholeTable: ['patch_resource']
  },
  {
    site: '/resource 列表的上传者资源数',
    file: 'app/api/resource/service.ts',
    run: () =>
      getResourceList(
        { sortField: 'created', sortOrder: 'desc', ...page },
        filteredView
      ),
    wholeTable: ['patch_resource']
  },
  {
    // 排序键本身是点赞数的聚合, 比上一条多一张表
    site: '/resource 列表按点赞数排序',
    file: 'app/api/resource/service.ts',
    run: () =>
      getResourceList(
        { sortField: 'like', sortOrder: 'desc', ...page },
        filteredView
      ),
    wholeTable: ['user_patch_resource_like_relation', 'patch_resource']
  },
  {
    site: '粉丝列表的关注数与粉丝数',
    file: 'app/api/user/follow/follower/route.ts',
    run: () => getFollowerRoute(followListRequest),
    wholeTable: ['user_follow_relation', 'user_follow_relation']
  },
  {
    site: '关注列表的关注数与粉丝数',
    file: 'app/api/user/follow/following/route.ts',
    run: () => getFollowingRoute(followListRequest),
    wholeTable: ['user_follow_relation', 'user_follow_relation']
  }
]

beforeEach(() => {
  recorder.reset()
  verifyHeaderCookieMock.mockResolvedValue({ uid: 42 })
  // 列表都带一次总数查询, 它要有一行结果
  recorder.reply(/^SELECT COUNT\(\*\)/, { rows: [{ _count$_all: 0n }] })
})

describe('带恒真过滤的关系 _count: 条件下推进聚合子查询', () => {
  it.each(pushdownCases)('$site', async ({ run, pushdown, wholeTable }) => {
    await run()

    const statements = recorder.take()
    expectAggregatePushdown(statements, pushdown)
    expect(wholeTableAggregates(statements)).toEqual(wholeTable)
  })
})

describe('列表里已知的整表聚合', () => {
  it.each(wholeTableCases)('$site', async ({ run, wholeTable }) => {
    await run()

    expect(wholeTableAggregates(recorder.take())).toEqual(wholeTable)
  })
})

// 源码里写在 Prisma 参数中的关系 _count, 按文件登记出现的次数。
//   list   列表查询: 上面必须有驱动它的用例 (带下推, 或登记为已知的整表聚合)
//   single 外层只按主键取一行 (findUnique、写入之后的读回)。编译出的聚合子查询与列表是
//          同一个形状, 但 PostgreSQL 会把那一个键值推进子查询 (17.11 实测, 带参数值的计划
//          与通用计划都是; 键多于一个就不推), 所以不算整表聚合, 只登记不驱动
// 新写了一处之后这里变红: 是列表就先想清楚聚合能不能带上条件, 再在上面加用例。
//
// 它管得到与管不到的: 扫描看的是「哪里写下了 _count」, 不是每一次查询。同一个文件里复用一个
// 本地的参数对象、把参数经别的变量或函数转手、`_count` 的值由函数算出, 这样写出来的新查询它
// 看不到 (导出的共享参数对象被谁导入, 由下面那张表另管)。次数与类别是人填的: 这张表保证的是
// 改动绕不开它, 给已经登记的文件加一个列表查询时, 用例要自己记得补
const relationCountSites: Record<
  string,
  { uses: number; kind: 'list' | 'single' }
> = {
  'app/api/admin/comment/get.ts': { uses: 1, kind: 'list' },
  'app/api/admin/creator/approve/route.ts': { uses: 1, kind: 'single' },
  'app/api/admin/creator/decline/route.ts': { uses: 1, kind: 'single' },
  'app/api/admin/creator/service.ts': { uses: 1, kind: 'list' },
  'app/api/admin/rating/get.ts': { uses: 1, kind: 'list' },
  'app/api/admin/resource/get.ts': { uses: 1, kind: 'list' },
  'app/api/admin/user/get.ts': { uses: 1, kind: 'list' },
  'app/api/apply/route.ts': { uses: 1, kind: 'single' },
  'app/api/home/service.ts': { uses: 1, kind: 'list' },
  'app/api/patch/comment/get.ts': { uses: 1, kind: 'list' },
  'app/api/patch/rating/get.ts': { uses: 1, kind: 'list' },
  'app/api/patch/rating/update.ts': { uses: 1, kind: 'single' },
  'app/api/patch/resource/create.ts': { uses: 1, kind: 'single' },
  // resourceInclude 上两处: 上传者资源数由资源 tab 的列表与资源详情共用; 点赞数只有详情
  // (按 id 取一行) 在用, 列表用 listInclude 里带过滤的第三处盖掉它
  'app/api/patch/resource/get.ts': { uses: 3, kind: 'list' },
  'app/api/patch/resource/update.ts': { uses: 1, kind: 'single' },
  // 一处在 select 里, 一处是按点赞数排序的 orderBy
  'app/api/resource/service.ts': { uses: 2, kind: 'list' },
  'app/api/user/follow/follower/route.ts': { uses: 1, kind: 'list' },
  'app/api/user/follow/following/route.ts': { uses: 1, kind: 'list' },
  'app/api/user/profile/comment/service.ts': { uses: 1, kind: 'list' },
  'app/api/user/profile/favorite/folder/create.ts': { uses: 1, kind: 'single' },
  'app/api/user/profile/favorite/folder/get.ts': { uses: 1, kind: 'list' },
  'app/api/user/profile/favorite/folder/update.ts': { uses: 1, kind: 'single' },
  'app/api/user/profile/floating/route.ts': { uses: 1, kind: 'single' },
  'app/api/user/profile/rating/service.ts': { uses: 1, kind: 'list' },
  'app/api/user/status/info/service.ts': { uses: 1, kind: 'single' }
}

// 导出的、带着关系 _count 的共享参数对象 (「文件#名字」), 以及导入它的文件。拿它去查询的
// 代码自己不写 `_count`, 上面那张表看不到, 所以新增一个导入者这里会红: 先确认它不是拿这个
// 对象去查列表 (那会把对象里不带过滤的聚合整个带过去), 再登记
const sharedCountArguments: Record<string, string[]> = {
  // 资源详情: 按 id 只取一行
  'app/api/patch/resource/get.ts#resourceInclude': [
    'app/api/patch/resource/detail.ts'
  ]
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

// 不放应用源码的顶层目录 (以点开头的目录另外排除)
const NON_SOURCE_ROOTS = new Set(['node_modules', 'docs', 'public'])

// 只看 .ts / .tsx, 读的是工作区 (没有提交的文件也算)
const applicationSources = () =>
  [
    ...globSync('*.{ts,tsx}', { cwd: repoRoot }),
    ...readdirSync(repoRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !NON_SOURCE_ROOTS.has(entry.name)
      )
      .flatMap((entry) =>
        globSync(`${entry.name}/**/*.{ts,tsx}`, { cwd: repoRoot })
      )
  ].filter(
    (file) =>
      !/(^|\/)__tests__\//.test(file) &&
      !file.startsWith('prisma/generated/') &&
      !file.endsWith('.d.ts')
  )

const parse = (file: string, text: string) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)

const propertyNameOf = (name: ts.PropertyName) => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text
  }
  return ts.isComputedPropertyName(name) &&
    ts.isStringLiteralLike(name.expression)
    ? name.expression.text
    : undefined
}

// 写在 Prisma 参数里的 _count: select / include 里的 `_count: { select }`、`_count: true`,
// 以及 orderBy 里的 `{ _count: 方向 }`。认不出来的写法 (值是一个变量、简写属性) 也算, 宁可
// 多报。不算的是:
// - 响应里的 _count —— 值取自查询结果 (x._count)、由函数算出、或是一个没有 select 的对象
//   (逐项拼出来的计数, 以及 groupBy 的 `_count: { _all: true }`)
// - 直接写在调用实参里的 `_count: true`: 那是 groupBy / aggregate 自己的总数
const isRelationCountArgument = (node: ts.Node) => {
  if (ts.isShorthandPropertyAssignment(node)) {
    return node.name.text === '_count'
  }
  if (
    !ts.isPropertyAssignment(node) ||
    propertyNameOf(node.name) !== '_count'
  ) {
    return false
  }
  const value = node.initializer
  if (ts.isPropertyAccessExpression(value) || ts.isCallExpression(value)) {
    return false
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some(
      (property) => property.name && propertyNameOf(property.name) === 'select'
    )
  }
  return !(
    value.kind === ts.SyntaxKind.TrueKeyword &&
    ts.isCallExpression(node.parent.parent)
  )
}

const isExported = (node: ts.HasModifiers) =>
  ts
    .getModifiers(node)
    ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false

// 这处 _count 若不是直接写在某次调用的实参里, 而是写在一个导出的具名对象 (或返回它的函数)
// 上, 返回那个名字。只认最近的那一层声明: 包在导出函数里的本地变量不算
const exportedCarrierOf = (node: ts.Node) => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current)) {
      return undefined
    }
    if (ts.isVariableDeclaration(current)) {
      const statement = current.parent.parent
      return ts.isIdentifier(current.name) &&
        ts.isVariableStatement(statement) &&
        isExported(statement)
        ? current.name.text
        : undefined
    }
    if (ts.isFunctionDeclaration(current)) {
      return current.name && isExported(current) ? current.name.text : undefined
    }
  }
  return undefined
}

const scanRelationCountArguments = (file: string, text: string) => {
  let uses = 0
  const carriers = new Set<string>()
  const visit = (node: ts.Node) => {
    if (isRelationCountArgument(node)) {
      uses += 1
      const carrier = exportedCarrierOf(node)
      if (carrier) {
        carriers.add(carrier)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(file, text))
  return { uses, carriers: [...carriers] }
}

// file 是否从 target 导入 (或转手导出) 了 name。`~/` 别名与相对路径都解析; 整个模块导入
// (import * as) 也算, 宁可多报
const importsFrom = (
  file: string,
  text: string,
  target: string,
  name: string
) =>
  parse(file, text).statements.some((statement) => {
    if (
      !(
        ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
      ) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      return false
    }
    const specifier = statement.moduleSpecifier.text
    const base = specifier.startsWith('~/')
      ? specifier.slice(2)
      : specifier.startsWith('.')
        ? posix.join(posix.dirname(file), specifier)
        : undefined
    if (
      base === undefined ||
      ![`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].includes(target)
    ) {
      return false
    }
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : statement.exportClause
    if (!bindings) {
      // export * from, 或只为副作用的导入
      return ts.isExportDeclaration(statement)
    }
    if (ts.isNamespaceImport(bindings) || ts.isNamespaceExport(bindings)) {
      return true
    }
    return bindings.elements.some(
      (element) => (element.propertyName ?? element.name).text === name
    )
  })

const scanRepository = () => {
  const texts = new Map(
    applicationSources().map((file) => [
      file,
      readFileSync(`${repoRoot}/${file}`, 'utf-8')
    ])
  )
  const uses: Record<string, number> = {}
  const shared: Record<string, string[]> = {}
  for (const [file, text] of texts) {
    if (!text.includes('_count')) {
      continue
    }
    const found = scanRelationCountArguments(file, text)
    if (found.uses > 0) {
      uses[file] = found.uses
    }
    for (const name of found.carriers) {
      shared[`${file}#${name}`] = [...texts]
        .filter(
          ([other, otherText]) =>
            other !== file &&
            otherText.includes(name) &&
            importsFrom(other, otherText, file, name)
        )
        .map(([other]) => other)
        .sort()
    }
  }
  return { uses, shared }
}

describe('源码里的关系 _count 都已登记', () => {
  const repository = scanRepository()

  it('扫描范围: 根目录与各源码目录下的 .ts / .tsx, 不含测试、生成的 client 与类型声明', () => {
    const sources = applicationSources()

    expect(sources).toEqual(
      expect.arrayContaining([
        'proxy.ts',
        'app/layout.tsx',
        'app/api/home/service.ts',
        'prisma/index.ts'
      ])
    )
    expect(
      sources.filter((file) =>
        /(^|\/)(__tests__|node_modules|docs)\/|^prisma\/generated\/|\.d\.ts$/.test(
          file
        )
      )
    ).toEqual([])
  })

  it('写下 _count 的每个文件都在登记表里, 次数一致', () => {
    const registered = Object.fromEntries(
      Object.entries(relationCountSites).map(([file, site]) => [
        file,
        site.uses
      ])
    )

    expect(repository.uses).toEqual(registered)
  })

  it('导出的共享参数对象与导入它的文件都已登记', () => {
    expect(repository.shared).toEqual(sharedCountArguments)
  })

  it('登记为列表的文件都有驱动它的用例, 用例驱动的也都登记为列表', () => {
    const driven = [...pushdownCases, ...wholeTableCases].map(
      (testCase) => testCase.file
    )
    const lists = Object.entries(relationCountSites)
      .filter(([, site]) => site.kind === 'list')
      .map(([file]) => file)

    expect([...new Set(driven)].sort()).toEqual(lists.sort())
  })

  it.each([
    ['select 里带 select 的写法', '({ _count: { select: { a: true } } })', 1],
    ['select 里的 true', '({ select: { _count: true } })', 1],
    ['orderBy 里的方向', '({ like_by: { _count: order } })', 1],
    ['值是一个变量', '({ include: { user: true, _count: countArgs } })', 1],
    ['简写属性', '({ include: { _count } })', 1],
    ['键写成字符串', `({ select: { '_count': true } })`, 1],
    ['键写成方括号里的字符串', `({ select: { ['_count']: true } })`, 1],
    ['响应: 取自查询结果', '({ name, _count: folder._count })', 0],
    ['响应: 由函数算出', '({ _count: toGalgameCardCount(row) })', 0],
    ['响应: 逐项拼出来', '({ _count: { follower: data._count.a } })', 0],
    ['groupBy 的分组计数', 'groupBy({ by: [x], _count: { _all: true } })', 0],
    ['groupBy 的总数', 'groupBy({ by: [x], _count: true })', 0],
    ['aggregate 的总数', 'aggregate({ _count: true })', 0],
    ['类型声明', 'interface A { _count: { patch: number } }', 0],
    ['注释与字符串', '// _count: true\nconst s = "_count: true"', 0]
  ])('扫描器数次数: %s', (_label, text, uses) => {
    expect(scanRelationCountArguments('probe.ts', text).uses).toBe(uses)
  })

  it.each([
    ['导出的对象', 'export const inc = { _count: { select: {} } }', ['inc']],
    [
      '导出的、返回对象的函数',
      'export const inc = (id: number) => ({ _count: { select: {} } })',
      ['inc']
    ],
    [
      '导出的函数声明',
      'export function inc() { return { _count: { select: {} } } }',
      ['inc']
    ],
    ['没有导出的对象', 'const inc = { _count: { select: {} } }', []],
    [
      '直接写在查询实参里',
      'export const get = () => db.a.findMany({ include: { _count: { select: {} } } })',
      []
    ]
  ])('扫描器认共享参数对象: %s', (_label, text, carriers) => {
    expect(scanRelationCountArguments('probe.ts', text).carriers).toEqual(
      carriers
    )
  })

  it.each([
    ['相对路径的具名导入', `import { inc } from './carrier'`, true],
    ['别名路径加改名', `import { inc as other } from '~/dir/carrier'`, true],
    ['整个模块导入', `import * as carrier from './carrier'`, true],
    ['转手导出', `export { inc } from './carrier'`, true],
    ['全部转手导出', `export * from './carrier'`, true],
    ['同一模块的别的名字', `import { different } from './carrier'`, false],
    ['别的模块的同名导出', `import { inc } from './other'`, false],
    ['只为副作用的导入', `import './carrier'`, false]
  ])('扫描器认导入者: %s', (_label, text, imports) => {
    expect(importsFrom('dir/user.ts', text, 'dir/carrier.ts', 'inc')).toBe(
      imports
    )
  })
})
