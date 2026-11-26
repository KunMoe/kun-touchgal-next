import '../validations/dotenv-check'
import { execSync } from 'child_process'
import { rmSync } from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { kunReportDeployChain, kunRunDeployChain } from './deployChain'
import {
  isReleaseId,
  kunRepoReleaseLayout,
  listReleases,
  releaseDirOf
} from './release/layout'
import {
  assembleRelease,
  discardRelease,
  readStaticOwn
} from './release/assemble'
import { KUN_DEFAULT_SMOKE, runCanary } from './release/smoke'
import { kunReleaseGuardPath } from './release/verify'
import { activateRelease, kunFetchHealth } from './release/activate'
import { createKunPm2, kunEcosystemApps } from './release/pm2'
import { assertShellNodeVersion, kunDeclaredNodeVersion } from './release/node'
import type { ReleaseId } from './release/layout'
import type { SmokeCheck } from './release/smoke'

// 用法: pnpm deploy:build [ref]。不给 ref 就在当前分支上 git pull --ff-only
const ref = process.argv[2]
const repoDir = process.cwd()
const layout = kunRepoReleaseLayout(repoDir)
const stagedDistDir = '.next-deploy'
// 构建不连库: 预渲染或构建期的探测渲染一旦查库, 构建就在这里失败, 而不是连上生产库与 17 个在线
// 进程抢连接槽 (07-31 的 P2037)。运行期的地址不受影响: standalone 里的 .env 是从文件复制的
const unreachableDatabaseUrl =
  'postgresql://kun-build:unreachable@127.0.0.1:1/kun-build'

// 部署链只经手 assemble 返回的 id
const asReleaseId = (value: string): ReleaseId => {
  if (!isReleaseId(value)) {
    throw new Error(`不是发布 id: ${value}`)
  }
  return value
}

const runCommand = (command: string, env: NodeJS.ProcessEnv = process.env) => {
  execSync(command, { stdio: 'inherit', env })
}

// 取回标准输出供部署链判断, 同时照常打印, 部署日志里不缺这一段
const captureCommand = (command: string) => {
  const output = execSync(command, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit']
  })
  process.stdout.write(output)
  return output
}

// 金丝雀照 PM2 的 web 进程起: 环境变量取 ecosystem 里 web 的那几项 (端口与 cron 开关由金丝雀自己定),
// 其余由发布自己的 .env 提供
const canaryEnv = () => {
  const ecosystem = createRequire(import.meta.url)(
    path.join(repoDir, 'ecosystem.config.cjs')
  ) as { apps: { env?: Record<string, unknown> }[] }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(ecosystem.apps[0]?.env ?? {})) {
    if (key !== 'PORT' && key !== 'KUN_ENABLE_CRON') {
      env[key] = String(value)
    }
  }
  return env
}

// 部署前打开的页面之后懒加载的 chunk 要还在: 取上一个发布自己构建、这个发布没有的一个 chunk, 金丝雀
// 请求它, 证明带过来的旧文件进了 Next 启动时的静态资源清单
const carriedChunkCheck = (releaseId: ReleaseId): SmokeCheck[] => {
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

console.log('Environment variables are valid.')
console.log('Executing the commands...')

if (process.env.KUN_VISUAL_NOVEL_TEST_SITE_LABEL) {
  console.log('DANGEROUS❗❗❗❗❗❗❗❗❗❗❗❗❗❗❗')
  console.log(
    'You website is running on a test environment now, it will be disable any search engine indexing!'
  )
}

process.exitCode = kunReportDeployChain(
  await kunRunDeployChain({
    ref,
    run: runCommand,
    capture: captureCommand,
    // .node-version 取自刚切到的版本
    preflight: () => assertShellNodeVersion(kunDeclaredNodeVersion(repoDir)),
    build: () => {
      rmSync(stagedDistDir, { recursive: true, force: true })
      runCommand('nice -n 10 pnpm build', {
        ...process.env,
        NODE_ENV: 'production',
        KUN_NEXT_DIST_DIR: stagedDistDir,
        KUN_DATABASE_URL: unreachableDatabaseUrl
      })
    },
    assemble: () => {
      const gitSha = captureCommand('git rev-parse HEAD').trim()
      const manifest = assembleRelease({
        layout,
        standaloneDir: path.join(stagedDistDir, 'standalone'),
        distDir: stagedDistDir,
        gitSha,
        now: new Date(),
        node: process.version
      })
      console.log(
        `\n发布 ${manifest.id} 已移进 ${releaseDirOf(layout, manifest.id)}`
      )
      return manifest.id
    },
    canary: async (rawId) => {
      const releaseId = asReleaseId(rawId)
      const checks = [...KUN_DEFAULT_SMOKE, ...carriedChunkCheck(releaseId)]
      console.log(
        `\n金丝雀: 在备用端口上启动 ${releaseId}, 检查 ${checks.length} 项`
      )
      const result = await runCanary({
        releaseDir: releaseDirOf(layout, releaseId),
        releaseId,
        env: canaryEnv(),
        checks,
        guardPath: kunReleaseGuardPath
      })
      if (!result.ok) {
        console.error(result.output)
        for (const failure of result.failures) {
          console.error(`  - ${failure}`)
        }
        discardRelease(layout, releaseId)
        throw new Error(`金丝雀没有通过 (${result.failures.length} 项)`)
      }
      console.log('金丝雀通过')
    },
    activate: async (rawId) => {
      const releaseId = asReleaseId(rawId)
      const apps = kunEcosystemApps(repoDir)
      const result = await activateRelease(
        {
          layout,
          pm2: createKunPm2({ repoDir, apps, run: runCommand }),
          apps,
          expectedNode: kunDeclaredNodeVersion(repoDir),
          fetchHealth: kunFetchHealth,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          log: (message) => console.log(message)
        },
        releaseId
      )
      if (result.ok) {
        console.log(
          `\n✓ 已切换到 ${releaseId}${result.pruned.length > 0 ? `, 删除了更早的发布 ${result.pruned.join(', ')}` : ''}`
        )
        return
      }
      console.error(`\n✗ ${result.reason}`)
      if (result.rollbackFailed) {
        console.error(
          `✗ 换回上一版也失败了: ${result.rollbackFailed}。线上可能没有在服务: 立刻用 pm2 ls 与 pnpm deploy:list 查看`
        )
      } else {
        // 没过闸门的发布不留: 留着它会占一个保留名额, 下一次部署成功之后还会成为 deploy:rollback 的默认目标
        discardRelease(layout, releaseId)
        console.error(
          `已换回 ${result.rolledBackTo ?? '检出里的旧构建 (旧布局)'}, 发布 ${releaseId} 已删除`
        )
      }
      throw new Error(`切换到 ${releaseId} 没有通过`)
    }
  })
)
