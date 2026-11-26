// 把前几个发布的静态资源硬链接进新发布。Next 的生产服务器只在启动时清点一次 <distDir>/static,
// 只服务清点到的文件; chunk 的文件名带内容哈希。部署之前打开的页面之后再懒加载 next/dynamic 的
// chunk 时, 那个 chunk 只存在于上一次构建里, 不带过来就是 404。所以要在新发布启动之前带过来。
// 硬链接不占额外的盘, 但要求同一个文件系统 (发布根的位置保证了这一点, 见 layout.cjs)
import fs from 'fs'
import path from 'path'

export interface StaticSource {
  staticDir: string
  // 相对 staticDir 的 POSIX 路径
  files: readonly string[]
}

// staticDir 下所有普通文件相对它的 POSIX 路径, 排好序; 目录不存在时是空的
export const listStaticFiles = (staticDir: string): string[] => {
  const files: string[] = []
  const walk = (relative: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(staticDir, relative), {
        withFileTypes: true
      })
    } catch (error) {
      if (
        relative === '' &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return
      }
      throw error
    }
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        walk(child)
      } else if (entry.isFile()) {
        files.push(child)
      }
    }
  }
  walk('')
  return files.sort()
}

// 只认 listStaticFiles 写得出来的形状: 绝对路径或带 .. 的条目会落到 staticDir 外面
const isPlainRelative = (file: string) =>
  file !== '' &&
  !path.isAbsolute(file) &&
  file.split('/').every((part) => part !== '' && part !== '.' && part !== '..')

// 把各来源列出的文件硬链接进 targetStaticDir, 返回新建的链接数。目标里已有的路径一律不动:
// 新构建自己的文件优先, 多个来源列了同一个文件时先列的来源优先。来源里已经没有的文件跳过
export const carryOverStatic = (
  targetStaticDir: string,
  sources: readonly StaticSource[]
): number => {
  let linked = 0
  for (const source of sources) {
    for (const file of source.files) {
      if (!isPlainRelative(file)) {
        continue
      }
      const from = path.join(source.staticDir, file)
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(from)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue
        }
        throw error
      }
      if (!stat.isFile()) {
        continue
      }
      const to = path.join(targetStaticDir, file)
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        // link 从不覆盖已有的路径 (EEXIST); 路径上有一段是文件时是 ENOTDIR。两种都是目标里
        // 已经有东西占着, 按「新构建优先」跳过。其余错误 (跨文件系统、没有空间) 照常抛出
        fs.linkSync(from, to)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST' || code === 'ENOTDIR') {
          continue
        }
        throw error
      }
      linked += 1
    }
  }
  return linked
}
