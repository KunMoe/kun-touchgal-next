import fs from 'fs'
import path from 'path'

const getRuntimeRoots = () => {
  const cwd = process.cwd()
  return [cwd, path.resolve(cwd, '../..')]
}

// 两处 path.join 上的 turbopackIgnore 不能去掉。少了它, Turbopack 认不出这里要读哪些
// 文件, 就把整个项目目录 (连同 docs/ 下十几万个本地文件) 都当成这个模块的依赖去追踪:
// 项目里每多出一个文件, 带缓存的 next build 就要把整份清单重算一遍, 而且一轮比一轮慢
// (实测连续三轮 66 秒 → 2.1 分钟 → 3 分钟), 全部源码还会被顺带复制进 standalone。
// 运行时真正要读的只有 posts/ 与 config/redirect.json, 由 scripts/postbuild.ts 复制
const resolveRuntimePath = (
  relativePath: string,
  type: 'file' | 'directory'
) => {
  for (const root of getRuntimeRoots()) {
    const fullPath = path.join(/* turbopackIgnore: true */ root, relativePath)

    try {
      const stats = fs.statSync(fullPath)
      if (type === 'file' && stats.isFile()) {
        return fullPath
      }
      if (type === 'directory' && stats.isDirectory()) {
        return fullPath
      }
    } catch {
      continue
    }
  }

  return path.join(/* turbopackIgnore: true */ process.cwd(), relativePath)
}

export const resolveRuntimeFile = (relativePath: string) =>
  resolveRuntimePath(relativePath, 'file')

export const resolveRuntimeDirectory = (relativePath: string) =>
  resolveRuntimePath(relativePath, 'directory')
