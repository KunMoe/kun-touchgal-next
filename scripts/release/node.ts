import fs from 'fs'
import path from 'path'

// 线上 Node 版本只在仓库根的 .node-version 声明 (CI 的 setup-node 也读它)。部署脚本跑在当前 shell 的
// node 上; PM2 守护进程常驻, 它拉起的应用用的是守护进程自己的 node, 只有 pm2 update (或 kill 后重起)
// 才会换成 CLI 当时的 node。所以部署先要求 shell 与声明一致, 切换之后再核对每个进程实际跑的版本
export const KUN_NODE_VERSION_FILE = '.node-version'

export const kunDeclaredNodeVersion = (repoDir: string) => {
  const raw = fs
    .readFileSync(path.join(repoDir, KUN_NODE_VERSION_FILE), 'utf8')
    .trim()
  const version = raw.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `${KUN_NODE_VERSION_FILE} 的内容不是完整的版本号 (形如 26.12.1): ${raw}`
    )
  }
  return version
}

export const assertShellNodeVersion = (
  declared: string,
  actual = process.versions.node
) => {
  if (actual !== declared) {
    throw new Error(
      `当前 shell 的 Node 是 v${actual}, 与 ${KUN_NODE_VERSION_FILE} 声明的 v${declared} 不一致。` +
        `先 nvm install ${declared} && nvm alias default ${declared} 并在新的 shell 里重跑; ` +
        `要换线上的 Node 版本就改 ${KUN_NODE_VERSION_FILE} 并提交`
    )
  }
}
