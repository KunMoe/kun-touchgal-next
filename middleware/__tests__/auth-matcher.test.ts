import { describe, expect, it } from 'vitest'
import { config } from '~/proxy'
import { protectedPaths } from '~/middleware/auth'

// 登录保护由两处配置合力生效, 且分居两个文件:
//   proxy.ts 的 config.matcher  -> 中间件是否运行
//   middleware/auth.ts 的 protectedPaths -> 运行后是否拦截
// 任一侧缺项都会让保护静默失效, 且没有运行时错误。真实案例:
// df8c0b49 删除 /comment 页面时删了 protectedPaths 一侧, 漏删 matcher 一侧,
// 死配置在仓库里留存了三个月。反方向 (加了 protectedPaths 忘了 matcher)
// 更危险 —— 那会让人以为某条路由受保护, 而中间件根本不会被调用。

// '/admin/:path*' -> '/admin'; /api 一侧走 CSRF 而非登录保护, 不参与比对
const toProtectedPrefix = (entry: string): string | null => {
  if (entry.startsWith('/api/')) {
    return null
  }
  return entry.replace(/\/:path\*$/, '')
}

const matcherPrefixes = (matcher: string[]) =>
  matcher.map(toProtectedPrefix).filter((entry) => entry !== null)

describe('proxy matcher 与 protectedPaths 同步', () => {
  // protectedPaths 是导出的共享数组, sort 前必须拷贝;
  // matcherPrefixes 已返回新数组, 无需再展开一次
  it('两侧必须逐项一致', () => {
    expect(matcherPrefixes(config.matcher).sort()).toEqual(
      [...protectedPaths].sort()
    )
  })
})

// 上面的断言依赖 toProtectedPrefix 正确剥离 matcher 语法。若它退化成恒返回
// null, 主断言会变成对空集的比对而静默通过, 故在此固定其行为。
describe('toProtectedPrefix', () => {
  it('剥离 :path* 后缀', () => {
    expect(toProtectedPrefix('/admin/:path*')).toBe('/admin')
    expect(toProtectedPrefix('/edit')).toBe('/edit')
  })

  it('只排除 /api 路由段, 不误伤同前缀路径', () => {
    expect(toProtectedPrefix('/api/((?!upload/).*)')).toBe(null)
    expect(toProtectedPrefix('/api-docs/:path*')).toBe('/api-docs')
  })

  it('批量归一化不丢项', () => {
    expect(matcherPrefixes(['/admin/:path*', '/comment/:path*'])).toEqual([
      '/admin',
      '/comment'
    ])
    // 归一化成空串的项不该被 filter 连带吞掉
    expect(matcherPrefixes(['/:path*'])).toEqual([''])
  })
})
