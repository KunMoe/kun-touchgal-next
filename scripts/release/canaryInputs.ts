// 部署链交给金丝雀与 PM2 的输入: 金丝雀的环境变量、要多请求的旧 chunk、PM2 命令的环境变量
import { createRequire } from 'module'
import path from 'path'
import { listReleases, releaseDirOf } from './layout'
import { readStaticOwn } from './assemble'
import type { ReleaseId, ReleaseLayout } from './layout'
import type { SmokeCheck } from './smoke'

interface EcosystemApp {
  name?: string
  env?: Record<string, unknown>
}

// 金丝雀照 PM2 的 web 进程起: 取 ecosystem 里不跑 cron 的那个 app 的环境变量 (端口与 cron 开关由金丝雀
// 自己定), 其余由发布自己的 .env 提供。按 KUN_ENABLE_CRON 挑, 不按顺序: cron 那个带
// NEXT_MANUAL_SIG_HANDLE, 金丝雀拿到它收到 SIGTERM 时不会先关 HTTP
export const kunCanaryEnv = (repoDir: string): Record<string, string> => {
  const ecosystem = createRequire(import.meta.url)(
    path.join(repoDir, 'ecosystem.config.cjs')
  ) as { apps: EcosystemApp[] }
  const web = ecosystem.apps.find((app) => app.env?.KUN_ENABLE_CRON === 'false')
  if (!web?.env) {
    throw new Error('ecosystem.config.cjs 里没有 KUN_ENABLE_CRON=false 的 app')
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(web.env)) {
    if (key !== 'PORT' && key !== 'KUN_ENABLE_CRON') {
      env[key] = String(value)
    }
  }
  return env
}

// 部署前打开的页面之后懒加载的 chunk 要还在: 取上一个发布自己构建、这个发布没有的一个 chunk, 金丝雀
// 请求它, 证明带过来的旧文件进了 Next 启动时的静态资源清单
export const kunCarriedChunkCheck = (
  layout: ReleaseLayout,
  releaseId: ReleaseId
): SmokeCheck[] => {
  const releases = listReleases(layout)
  const fresh = releases.find((release) => release.id === releaseId)
  const previous = releases.find((release) => release.id !== releaseId)
  if (!fresh || !previous) {
    return []
  }
  const own = new Set(readStaticOwn(releaseDirOf(layout, fresh.id)))
  const carried = readStaticOwn(releaseDirOf(layout, previous.id)).find(
    (file) =>
      file.startsWith('chunks/') && file.endsWith('.js') && !own.has(file)
  )
  return carried
    ? [{ path: `/_next/static/${carried}`, expectStatus: 200 }]
    : []
}

// 交给 PM2 命令的环境变量。部署进程开头由 dotenv-check 把检出的 .env 加载进了 process.env, PM2 又会把
// CLI 的环境并进每个 app (pm2 update 时还会冻进新的守护进程, pm2 save 写进 dump): 不剔除的话, 在线
// 进程的配置来自部署那一刻检出的 .env, 而不是发布自己的 .env, 与金丝雀不一致。只剔除值与 .env 里
// 相同的键 (shell 里另外导出、值不同的保留); 发布 id 永远只来自发布自己的 .env
export const kunPm2Env = (
  env: NodeJS.ProcessEnv,
  checkoutDotenv: Record<string, string>
): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = { ...env }
  for (const [key, value] of Object.entries(checkoutDotenv)) {
    if (result[key] === value) {
      delete result[key]
    }
  }
  delete result.KUN_RELEASE_ID
  delete result.KUN_RELEASE_SHA
  return result
}
