import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// 发布相关测试的临时目录放在仓库的 node_modules/.cache 下 (git、eslint、vitest、tsc 都不看它),
// 不写系统临时目录。注意它的上级就有仓库的 node_modules: 测「解析逃到发布外面」时正好用得上
const base = fileURLToPath(
  new URL('../../../../node_modules/.cache/kun-release-tests', import.meta.url)
)

export const makeTempDir = (prefix: string) => {
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, `${prefix}-`))
}

export const removeTempDir = (dir: string) => {
  fs.rmSync(dir, { recursive: true, force: true })
}
