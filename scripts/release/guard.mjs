// 发布的模块解析守卫, 用 node --import <本文件> 加载: verify.ts 的外部包探测与 smoke.ts 的金丝雀都带着它跑。
//
// standalone 里缺的模块会沿目录向上解析。在检出里构建、验证时, 向上就落进检出的 node_modules,
// 缺失被悄悄补上; 发布移到检出之外上线后才炸。这里记下每一次从 KUN_RELEASE_GUARD_ROOT 里面解析到
// 外面的文件 (按 realpath 判定), 一行一个 JSON ({ specifier, resolved, parent }) 同步追加到
// KUN_RELEASE_GUARD_REPORT, 由调用方读取。只记越界的那一跳: 发起方已经在外面的解析 (逃出去的包
// 再加载它自己的文件) 是那一跳的后果, 一个包就有上百行, 不记
//
// 只看不改: 不抛错、不改变解析结果, 只导入 Node 内置模块 (本文件自己的导入发生在钩子装上之前)。
// 钩子装上之后建出 (可能为空的) 报告文件: 调用方据此确认守卫确实生效了, 不然「没有逃逸」可能只是钩子没装上。
// 两个环境变量缺任何一个就什么都不做
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
  // 同一处解析会反复发生 (CommonJS 每次 require 都过钩子), 报告里每种只写一行
  const reported = new Set()

  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context)
      try {
        const resolved = pathOf(result?.url)
        const parentUrl = context?.parentURL
        const parentPath = pathOf(parentUrl)
        if (
          resolved !== null &&
          isOutside(realOf(resolved)) &&
          (parentPath === null || !isOutside(realOf(parentPath)))
        ) {
          const line = JSON.stringify({
            specifier,
            resolved: realOf(resolved),
            parent: parentPath ?? parentUrl ?? null
          })
          if (!reported.has(line)) {
            reported.add(line)
            fs.appendFileSync(report, `${line}\n`)
          }
        }
      } catch {
        // 守卫自己出的任何问题都不能波及被守卫的进程
      }
      return result
    }
  })
  fs.appendFileSync(report, '')
}

try {
  install()
} catch {
  // 同上: 装不上就当没有守卫, 调用方看到报告文件不存在会报出来
}
