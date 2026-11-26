import '../validations/dotenv-check'
import { execSync } from 'child_process'
import { readFileSync, rmSync, statSync } from 'fs'
import path from 'path'
import { parse } from 'dotenv'
import { kunReportDeployChain, kunRunDeployChain } from './deployChain'
import {
  isReleaseId,
  kunRepoReleaseLayout,
  releaseDirOf
} from './release/layout'
import { assembleRelease, discardRelease } from './release/assemble'
import {
  kunCanaryEnv,
  kunCarriedChunkCheck,
  kunPm2Env
} from './release/canaryInputs'
import { KUN_DEFAULT_SMOKE, runCanary } from './release/smoke'
import { kunReleaseGuardPath } from './release/verify'
import { activateRelease, kunFetchHealth } from './release/activate'
import { createKunPm2, kunEcosystemApps } from './release/pm2'
import { assertShellNodeVersion, kunDeclaredNodeVersion } from './release/node'
import type { ReleaseId } from './release/layout'

// 用法: pnpm deploy:build [ref]。不给 ref 就在当前分支上 git pull --ff-only
const [ref] = process.argv.slice(2).filter((arg) => arg !== '--')
const repoDir = process.cwd()
const layout = kunRepoReleaseLayout(repoDir)
const stagedDistDir = '.next-deploy'
// 构建不连库: 预渲染或构建期的探测渲染一旦查库, 构建就在这里失败, 而不是连上生产库与 17 个在线
// 进程抢连接槽 (07-31 的 P2037)。运行期的地址不受影响: standalone 里的 .env 是从文件复制的
const unreachableDatabaseUrl =
  'postgresql://kun-build:unreachable@127.0.0.1:1/kun-build'

// 切换没过闸门、换回上一版也没做成: 线上可能没有在服务, 退出码与「线上没变」的 1 分开
const ROLLBACK_FAILED_EXIT_CODE = 3

class KunRollbackFailedError extends Error {}

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

// PM2 的命令不带检出 .env 加载进来的变量: 在线进程只从发布自己的 .env 取配置, 与金丝雀一致
// (原因见 kunPm2Env)
const pm2Env = kunPm2Env(
  process.env,
  parse(readFileSync(path.join(repoDir, '.env'), 'utf8'))
)
const runPm2Command = (command: string) => {
  execSync(command, { cwd: repoDir, stdio: 'inherit', env: pm2Env })
}
const capturePm2Command = (command: string) =>
  execSync(command, {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: pm2Env
  })

// 发布靠 rename 从检出移进发布根, 不能跨文件系统: 在构建之前就查, 不要等几分钟的构建做完才报 EXDEV
const assertReleaseRootOnCheckoutFilesystem = () => {
  const probe = (() => {
    try {
      return statSync(layout.root)
    } catch {
      return statSync(path.dirname(layout.root))
    }
  })()
  if (probe.dev !== statSync(repoDir).dev) {
    throw new Error(
      `发布根 ${layout.root} 与检出 ${repoDir} 不在同一个文件系统上: 发布靠 rename 移进去、旧静态资源靠硬链接带过去, 都不能跨文件系统`
    )
  }
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

console.log('Environment variables are valid.')
console.log('Executing the commands...')

if (process.env.KUN_VISUAL_NOVEL_TEST_SITE_LABEL) {
  console.log('DANGEROUS❗❗❗❗❗❗❗❗❗❗❗❗❗❗❗')
  console.log(
    'You website is running on a test environment now, it will be disable any search engine indexing!'
  )
}

try {
  process.exitCode = kunReportDeployChain(
    await kunRunDeployChain({
      ref,
      run: runCommand,
      capture: captureCommand,
      // .node-version 取自刚切到的版本
      preflight: () => {
        assertShellNodeVersion(kunDeclaredNodeVersion(repoDir))
        assertReleaseRootOnCheckoutFilesystem()
      },
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
        const checks = [
          ...KUN_DEFAULT_SMOKE,
          ...kunCarriedChunkCheck(layout, releaseId)
        ]
        console.log(
          `\n金丝雀: 在备用端口上启动 ${releaseId}, 检查 ${checks.length} 项`
        )
        const result = await runCanary({
          releaseDir: releaseDirOf(layout, releaseId),
          releaseId,
          env: kunCanaryEnv(repoDir),
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
            pm2: createKunPm2({
              repoDir,
              apps,
              run: runPm2Command,
              capture: capturePm2Command
            }),
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
          throw new KunRollbackFailedError(
            `切换到 ${releaseId} 没有通过, 换回上一版也失败了`
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
} catch (error) {
  if (!(error instanceof KunRollbackFailedError)) {
    throw error
  }
  console.error(error.message)
  process.exitCode = ROLLBACK_FAILED_EXIT_CODE
}
