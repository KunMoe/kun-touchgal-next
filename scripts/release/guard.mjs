// 发布的模块解析守卫, 用 node --import <本文件> 加载: verify.ts 的外部包探测与 smoke.ts 的金丝雀都带着它跑。
//
// standalone 里缺的模块会沿目录向上解析。在检出里构建、验证时 (演练的发布根也在检出里), 向上就落进
// 检出的 node_modules, 缺失被悄悄补上; 生产的发布根之上没有 node_modules, 同一个解析在那里找不到。
// 所以这里把每一次从 KUN_RELEASE_GUARD_ROOT 里面解析到外面的文件 (按 realpath 判定) 都拦下来:
// 当作找不到抛出 (require 回 MODULE_NOT_FOUND, import 回 ERR_MODULE_NOT_FOUND, 与 Node 自己的一样,
// 按错误码兜底的代码照常走兜底), 进程的行为与生产的物理隔离一致; 同时一行一个 JSON
// ({ specifier, resolved, parent }) 同步追加到 KUN_RELEASE_GUARD_REPORT, 由调用方判断哪些是预期内的
// (verify.ts 的 KUN_EXPECTED_GUARD_ESCAPES)。发起方本身已在外面的解析不算越界 (只有钩子装上之前加载的
// 模块会这样, 比如本文件), 不拦也不记。
//
// 不是越界的解析原样放行; 非 file: 的结果 (内置模块、data:) 不看。只导入 Node 内置模块 (本文件自己的导入
// 发生在钩子装上之前)。钩子装上之后建出 (可能为空的) 报告文件: 调用方据此确认守卫确实生效了, 不然
// 「没有逃逸」可能只是钩子没装上。两个环境变量缺任何一个就什么都不做
import fs from 'node:fs'
import module from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const install = () => {
  const rootEnv = process.env.KUN_RELEASE_GUARD_ROOT
  const report = process.env.KUN_RELEASE_GUARD_REPORT
  if (!rootEnv || !report || typeof module.registerHooks !== 'function') {
    return
  }
  const root = fs.realpathSync(rootEnv)

  const realCache = new Map()
  const realOf = (file) => {
    let real = realCache.get(file)
    if (real === undefined) {
      try {
        real = fs.realpathSync(file)
      } catch {
        real = file
      }
      realCache.set(file, real)
    }
    return real
  }
  const pathOf = (url) => {
    if (typeof url !== 'string' || !url.startsWith('file:')) {
      return null
    }
    try {
      return fileURLToPath(url)
    } catch {
      return null
    }
  }
  const isOutside = (file) => {
    const relative = path.relative(root, file)
    return (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
  }
  // 越界时返回要记下的那一行, 否则 null
  const crossingOf = (specifier, context, result) => {
    const resolved = pathOf(result?.url)
    if (resolved === null || !isOutside(realOf(resolved))) {
      return null
    }
    const parentUrl = context?.parentURL
    const parentPath = pathOf(parentUrl)
    if (parentPath !== null && isOutside(realOf(parentPath))) {
      return null
    }
    return {
      resolved: realOf(resolved),
      line: JSON.stringify({
        specifier,
        resolved: realOf(resolved),
        parent: parentPath ?? parentUrl ?? null
      })
    }
  }
  const notFound = (specifier, context, resolved) => {
    const conditions = Array.from(context?.conditions ?? [])
    const error = new Error(
      `Cannot find module '${specifier}' (发布守卫拦下: 解析到的 ${resolved} 在发布 ${root} 之外)`
    )
    error.code = conditions.includes('require')
      ? 'MODULE_NOT_FOUND'
      : 'ERR_MODULE_NOT_FOUND'
    return error
  }
  // 同一处解析会反复发生 (CommonJS 每次 require 都过钩子), 报告里每种只写一行
  const reported = new Set()

  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context)
      let crossing = null
      try {
        crossing = crossingOf(specifier, context, result)
      } catch {
        // 判定本身出错就放行: 守卫自己的问题不能改变被守卫的进程
      }
      if (crossing === null) {
        return result
      }
      try {
        if (!reported.has(crossing.line)) {
          reported.add(crossing.line)
          fs.appendFileSync(report, `${crossing.line}\n`)
        }
      } catch {
        // 记不下来也照样拦: 拦下是与生产一致的行为, 记录只是给人看的
      }
      throw notFound(specifier, context, crossing.resolved)
    }
  })
  fs.appendFileSync(report, '')
}

try {
  install()
} catch {
  // 装不上就当没有守卫, 调用方看到报告文件不存在会报出来
}
