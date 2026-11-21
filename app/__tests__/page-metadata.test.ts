import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { generateKunMetadataTemplate as patchMetadata } from '~/app/[id]/metadata'
import { generateKunMetadataTemplate as resourceMetadata } from '~/app/[id]/resource/[resourceId]/metadata'
import { generateKunMetadataTemplate as companyMetadata } from '~/app/company/[id]/metadata'
import { generateKunMetadataTemplate as docMetadata } from '~/app/doc/[...slug]/metadata'
import { generateKunMetadata } from '~/app/metadata'
import { generateKunMetadataTemplate as tagMetadata } from '~/app/tag/[id]/metadata'
import { generateKunMetadataTemplate as userMetadata } from '~/app/user/[id]/metadata'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { KUN_ROUTE_POLICY, type KunCrawlPolicy } from '~/config/routePolicy'
import { buildKunSitemap } from '~/server/sitemap/entries'
import { kunDocumentTitle } from '~/utils/pageMetadata'
import { APP_DIR, listKunPages } from './support/pages'
import type { Metadata, ResolvedMetadata } from 'next'
import type { PatchResourceDetail } from '~/app/api/patch/resource/detail'
import type { KunBlog } from '~/lib/mdx/types'
import type { CompanyDetail } from '~/types/api/company'
import type { Patch, PatchIntroduction } from '~/types/api/patch'
import type { UserInfo } from '~/types/api/user'

// 这份护栏不读 metadata 怎么写, 只看 Next 最终解析出什么: 把每个页面真实的段链
// (根布局 → 各级 layout → page) 交给 Next 自己的 accumulateMetadata 重放一遍。
// 页面级 metadata 是整块替换与模板继承叠出来的, 单看某一个文件看不出页面最后输出了什么。
// accumulateMetadata 是 Next 的内部函数, 它的签名或解析行为变了这里会红。段链本身是照着
// resolve-metadata.js 的 resolveMetadataItemsImpl / collectMetadata 自己拼的 (每个路由段一项,
// 没有 layout 的段是 null, 最后一项是 page): 那两个函数变了这里不会红, 升级 Next 时要人工对一遍,
// 并核对 './' (resolve-url.js 的 resolveRelativeUrl) 是否仍按当前 pathname 解析
type AccumulateMetadata = (
  route: string,
  items: [Metadata | null, null][],
  pathname: string,
  context: { trailingSlash: boolean; isStaticMetadataRouteFile: boolean }
) => Promise<ResolvedMetadata>

const loadAccumulateMetadata = (): AccumulateMetadata => {
  const require = createRequire(import.meta.url)
  // resolve-metadata 一加载就 require('server-only'), 它的默认入口直接 throw。Vitest 的别名
  // 管不到原生 require, 只能在加载的这一下把它解析到 Next 自带的空模块
  const nodeModule = require('node:module') as {
    _resolveFilename: (request: string, ...rest: unknown[]) => string
  }
  const resolveFilename = nodeModule._resolveFilename
  nodeModule._resolveFilename = function (request, ...rest) {
    return request === 'server-only'
      ? require.resolve('next/dist/compiled/server-only/empty.js')
      : resolveFilename.call(this, request, ...rest)
  }
  try {
    return require('next/dist/lib/metadata/resolve-metadata.js')
      .accumulateMetadata
  } finally {
    nodeModule._resolveFilename = resolveFilename
  }
}

const accumulateMetadata = loadAccumulateMetadata()

// 重放时路由参数取的值。作品的 unique_id 与会社 / 标签 / 用户的 id 共用一个纯数字的 8 位串
const SAMPLE_PARAMS: Record<string, string> = {
  id: '12345678',
  resourceId: '42',
  slug: 'notice/role'
}

// 带 generateMetadata 的文件输出什么取决于运行时数据。它们都是「读数据 → 交给同目录
// metadata.ts 的模板函数」, 这里给每个文件一份夹具, 经真实的模板函数算出 metadata 再重放;
// 读数据那一步 (查库、notFound、NSFW 对游客的屏蔽) 不在这份护栏里。
// 新增带 generateMetadata 的 page / layout 要在这里登记一份夹具
const DYNAMIC_LAYERS: Record<string, Metadata> = {
  '[id]/page.tsx': patchMetadata(
    {
      uniqueId: SAMPLE_PARAMS.id,
      name: '某作品',
      alias: ['某别名'],
      platform: ['windows'],
      contentLimit: 'sfw',
      banner: 'https://img.example/banner.avif',
      user: { id: 1, name: '某发布者', avatar: '' },
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-02T00:00:00.000Z'
    } as Patch,
    { introduction: '<p>作品简介</p>' } as PatchIntroduction,
    false
  ),
  '[id]/resource/[resourceId]/page.tsx': resourceMetadata(
    {
      contentLimit: 'sfw',
      patchName: '某作品',
      resource: {
        id: Number(SAMPLE_PARAMS.resourceId),
        uniqueId: SAMPLE_PARAMS.id,
        name: '某资源',
        section: 'galgame',
        noteHtml: '<p>资源备注</p>'
      }
    } as PatchResourceDetail,
    false
  ),
  'company/[id]/page.tsx': companyMetadata({
    id: Number(SAMPLE_PARAMS.id),
    name: '某会社',
    introduction: '会社简介',
    alias: ['某会社别名'],
    created: '2026-01-01T00:00:00.000Z'
  } as CompanyDetail),
  'doc/[...slug]/page.tsx': docMetadata({
    slug: SAMPLE_PARAMS.slug,
    content: '',
    frontmatter: {
      title: '某文档',
      description: '文档描述',
      date: '2026-01-01',
      banner: 'https://img.example/doc.avif'
    }
  } as KunBlog),
  'tag/[id]/page.tsx': tagMetadata('某标签'),
  'user/[id]/layout.tsx': userMetadata({ name: '某用户' } as UserInfo)
}

const METADATA_EXPORT = /^export\b.*\b(?:metadata|generateMetadata)\b/m
const STATIC_EXPORT = /^export const metadata: Metadata = kunMetadata$/m
const STATIC_IMPORT = /^import \{ kunMetadata \} from '(\.{1,2}\/metadata)'$/m

const replayedDynamicLayers = new Set<string>()

// 一个 layout / page 文件声明的 metadata
const loadLayer = async (file: string): Promise<Metadata | null> => {
  if (!existsSync(file)) {
    return null
  }
  const source = readFileSync(file, 'utf-8')
  const exported = METADATA_EXPORT.exec(source)?.[0]
  if (!exported) {
    return null
  }
  if (exported.includes('generateMetadata')) {
    const key = relative(APP_DIR, file)
    if (!(key in DYNAMIC_LAYERS)) {
      throw new Error(
        `${file}: 带 generateMetadata 的文件要在 DYNAMIC_LAYERS 里登记一份夹具, 否则这份护栏不知道它输出什么`
      )
    }
    replayedDynamicLayers.add(key)
    return DYNAMIC_LAYERS[key]
  }
  const specifier = STATIC_IMPORT.exec(source)?.[1]
  if (!specifier || !STATIC_EXPORT.test(source)) {
    throw new Error(
      `${file}: 静态 metadata 要放进 metadata.ts 导出为 kunMetadata, 再由页面原样转出 (export const metadata: Metadata = kunMetadata), 否则这份护栏读不到它`
    )
  }
  const loaded = await import(resolve(dirname(file), `${specifier}.ts`))
  return loaded.kunMetadata as Metadata
}

interface PageChain {
  route: string
  // 路由参数换成 SAMPLE_PARAMS 后的地址, 相当于一次真实请求的 pathname
  pathname: string
  // 根布局之下的各级 layout, 最后一项是页面自己
  layers: (Metadata | null)[]
}

const chains: PageChain[] = []

for (const page of listKunPages()) {
  chains.push({
    route: page.route,
    pathname: page.route.replace(
      /\[(?:\.\.\.)?([^\]]+)\]/g,
      (_, name: string) => SAMPLE_PARAMS[name] ?? 'x'
    ),
    layers: await Promise.all([
      ...page.segments.map((_, index) =>
        loadLayer(
          join(APP_DIR, ...page.segments.slice(0, index + 1), 'layout.tsx')
        )
      ),
      loadLayer(join(APP_DIR, page.file))
    ])
  })
}

const replay = async (testSite: boolean) => {
  vi.stubEnv('KUN_VISUAL_NOVEL_TEST_SITE_LABEL', testSite ? 'test' : '')
  const root = generateKunMetadata()
  vi.unstubAllEnvs()

  const resolved = new Map<string, ResolvedMetadata>()
  for (const chain of chains) {
    resolved.set(
      chain.route,
      await accumulateMetadata(
        chain.route,
        [root, ...chain.layers].map((layer) => [layer, null]),
        chain.pathname,
        { trailingSlash: false, isStaticMetadataRouteFile: false }
      )
    )
  }
  return resolved
}

const production = await replay(false)
const testSite = await replay(true)

const ORIGIN = kunMoyuMoe.domain.main
// 流程结果页没有独立搜索价值, 规范地址刻意归一到父级 (#69 的裁定)
const CANONICAL_OVERRIDES: Record<string, string> = {
  '/apply/success': '/apply',
  '/apply/pending': '/apply'
}
// 这几个模板的 openGraph 还是手写的: 没有 og:url、站点名与语言, 社交标题也与页面标题不同。
// 只减不增: 哪个迁到 KUN_BASE_OPEN_GRAPH 之后这里会红, 那时把它从清单里删掉
const HANDWRITTEN_OPEN_GRAPH = [
  '/[id]',
  '/[id]/resource/[resourceId]',
  '/company/[id]',
  '/doc/[...slug]'
]
const HIDDEN: KunCrawlPolicy[] = ['noindex', 'blocked']

const policyOf = (route: string) =>
  (KUN_ROUTE_POLICY as Record<string, KunCrawlPolicy>)[route]
// robots 写成字符串时 Next 原样输出, 'noindex,nofollow' 与 'none' 都算
const isNoindex = (metadata: ResolvedMetadata) =>
  (metadata.robots?.basic ?? '')
    .toLowerCase()
    .split(/[\s,]+/)
    .some((token) => token === 'noindex' || token === 'none')

// 首页自己不声明 metadata, 它解析出的就是根布局给的
const rootRobots = production.get('/')!.robots

// 用同一组参数展开的站点地图
const submitted = new Set(
  buildKunSitemap({
    patches: [{ uniqueId: SAMPLE_PARAMS.id, resourceUpdateTime: new Date(0) }],
    companyIds: [Number(SAMPLE_PARAMS.id)],
    posts: [{ slug: SAMPLE_PARAMS.slug, date: '' }]
  }).map((entry) => entry.url)
)

describe('重放的范围', () => {
  it('根布局的 metadata 来自 generateKunMetadata', () => {
    expect(readFileSync(join(APP_DIR, 'layout.tsx'), 'utf-8')).toMatch(
      /^export const metadata: Metadata = generateKunMetadata\(\)$/m
    )
  })

  it('全部页面都重放了, 夹具没有多余的', () => {
    expect(chains).toHaveLength(Object.keys(KUN_ROUTE_POLICY).length)
    expect([...replayedDynamicLayers].sort()).toEqual(
      Object.keys(DYNAMIC_LAYERS).sort()
    )
  })
})

describe.each(chains)('$route', ({ route, pathname, layers }) => {
  const metadata = production.get(route)!
  const policy = policyOf(route)
  const title = metadata.title?.absolute ?? ''
  const selfUrl = ORIGIN + (pathname === '/' ? '' : pathname)
  const expectedUrl = CANONICAL_OVERRIDES[route]
    ? ORIGIN + CANONICAL_OVERRIDES[route]
    : selfUrl

  it('站点后缀恰好出现一次', () => {
    // 离页面最近的那一层声明的标题 (用户主页的各个标签页没有自己的标题, 用的是 layout 的)
    const declared = layers
      .map((layer) => layer?.title)
      .findLast((value) => typeof value === 'string')

    // 少一次: 上面某一层 layout 声明了字符串标题, 把根布局的模板清掉了
    expect(title).toBe(
      declared === undefined ? kunMoyuMoe.title : kunDocumentTitle(declared)
    )
    // 多一次: 标题里又手写了后缀。上一条的期望值取自声明的标题, 手写的后缀会跟着进期望值,
    // 所以要单独数。哪天真有页面标题需要提到站点名, 改这里
    expect(title.split(kunMoyuMoe.titleShort)).toHaveLength(2)
  })

  it('规范地址与 hreflang 指向自己', () => {
    if (metadata.alternates === null) {
      expect(HIDDEN).toContain(policy)
      return
    }
    expect(metadata.alternates.canonical?.url).toBe(expectedUrl)
    for (const entries of Object.values(metadata.alternates.languages ?? {})) {
      expect(entries?.map((entry) => entry.url)).toEqual([expectedUrl])
    }
  })

  it('og:url 与规范地址相同, 站点名、语言与带后缀的社交标题没有丢', () => {
    if (metadata.openGraph === null) {
      expect(HIDDEN).toContain(policy)
      return
    }
    if (HANDWRITTEN_OPEN_GRAPH.includes(route)) {
      expect(metadata.openGraph.url).toBeNull()
      return
    }
    expect(metadata.openGraph.url).toBe(expectedUrl)
    expect(metadata.openGraph.siteName).toBe(kunMoyuMoe.title)
    expect(metadata.openGraph.locale).toBe('zh_CN')
    expect(metadata.openGraph.title?.absolute).toBe(title)
    expect(metadata.twitter?.title?.absolute).toBe(title)
  })

  it('索引声明与 KUN_ROUTE_POLICY 的登记一致', () => {
    // 可索引的页面不自己写 robots, 原样继承根布局的 (含给 Googlebot 的那一份)
    if (policy === 'listed' || policy === 'unlisted') {
      expect(metadata.robots).toEqual(rootRobots)
    }
    if (policy === 'noindex') {
      expect(isNoindex(metadata)).toBe(true)
    }
  })

  it('测试站点上是 noindex', () => {
    expect(isNoindex(testSite.get(route)!)).toBe(true)
  })

  it('进不进站点地图与登记一致, 提交的地址就是页面的规范地址', () => {
    expect(submitted.has(selfUrl)).toBe(policy === 'listed')
    if (policy === 'listed') {
      expect(metadata.alternates?.canonical?.url).toBe(selfUrl)
    }
  })
})
