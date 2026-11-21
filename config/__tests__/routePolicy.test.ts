import { describe, expect, it } from 'vitest'
import {
  listKunPages,
  listNonTsxRouteFiles
} from '~/app/__tests__/support/pages'
import {
  KUN_ROBOTS_EXTRA_DISALLOW,
  KUN_ROUTE_POLICY,
  kunListedStaticRoutes,
  kunRobotsDisallow
} from '~/config/routePolicy'

const pageRoutes = listKunPages().map((page) => page.route)
const policyOf = (route: string) =>
  (KUN_ROUTE_POLICY as Record<string, string>)[route]

describe('KUN_ROUTE_POLICY', () => {
  it('与 app 下的 page.tsx 一一对应: 新页面要登记, 删掉的页面要除名', () => {
    expect(Object.keys(KUN_ROUTE_POLICY).sort()).toEqual([...pageRoutes].sort())
  })

  it('没有路由组与并行路由 (有了之后路由不再等于目录)', () => {
    expect(pageRoutes.filter((route) => /[(@]/.test(route))).toEqual([])
  })

  // 上一条与页面 metadata 的重放都只找 .tsx, 别的扩展名的页面会绕过登记, layout 会绕过重放
  it('page 与 layout 都是 .tsx', () => {
    expect(listNonTsxRouteFiles()).toEqual([])
  })
})

describe('kunRobotsDisallow', () => {
  const routeDisallow = kunRobotsDisallow().filter(
    (item) => !(KUN_ROBOTS_EXTRA_DISALLOW as readonly string[]).includes(item)
  )

  it('只输出最上层的 blocked 路由, 再加与路由无关的分页规则', () => {
    expect(kunRobotsDisallow()).toEqual([
      '/admin',
      '/message',
      '/tag',
      '/user',
      '/*?page=',
      '/*&page='
    ])
  })

  // Disallow 是字符串前缀匹配: /tag 同时盖住 /tags 这样的路由
  it.each(routeDisallow)('%s 这个前缀下没有不该禁抓的路由', (prefix) => {
    expect(
      pageRoutes.filter(
        (route) => route.startsWith(prefix) && policyOf(route) !== 'blocked'
      )
    ).toEqual([])
  })

  it('每条 blocked 路由都被某个前缀盖住', () => {
    expect(
      pageRoutes.filter(
        (route) =>
          policyOf(route) === 'blocked' &&
          !routeDisallow.some((prefix) => route.startsWith(prefix))
      )
    ).toEqual([])
  })

  // 带参数的段写不成前缀; 真出现时要决定用通配符还是换路由, 不能原样输出方括号
  it('前缀里没有路由参数', () => {
    expect(routeDisallow.filter((prefix) => prefix.includes('['))).toEqual([])
  })

  // 作品页的地址是 /<8 位十六进制>。一个只由十六进制字符组成的顶层前缀 (比如 /feed)
  // 会连带禁抓 id 以它开头的作品页, 而上面按路由写法比的用例看不出来
  it('前缀不会盖住作品页的地址', () => {
    expect(
      routeDisallow.filter((prefix) => /^\/[0-9a-f]{1,8}$/.test(prefix))
    ).toEqual([])
  })
})

describe('kunListedStaticRoutes', () => {
  it('只含 listed 且不带路由参数的路由, 首页在内', () => {
    const listed = kunListedStaticRoutes()

    expect(listed).toContain('/')
    expect(listed.filter((route) => policyOf(route) !== 'listed')).toEqual([])
    expect(listed.filter((route) => route.includes('['))).toEqual([])
    expect(listed).toHaveLength(
      pageRoutes.filter(
        (route) => policyOf(route) === 'listed' && !route.includes('[')
      ).length
    )
  })
})
