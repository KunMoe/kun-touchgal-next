// 部署与回滚对 PM2 的全部操作: 停、起、换守护进程的 Node、存进程列表、看每个进程的状态与 Node 版本。
// 应用的名字、端口与实例数只取 ecosystem.config.cjs, 闸门按它们核对进程
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { homedir } from 'os'
import path from 'path'

export interface KunAppSpec {
  name: string
  port: number
  instances: number
}

export interface KunPm2Process {
  // 同一个进程被 PM2 重启时不变。删掉之后编号会被复用
  pmId: number
  name: string
  status: string
  // 进程自己的 process.versions.node (不带 v)
  nodeVersion: string | null
  // PM2 自动重启过它几次 (pm2_env.restart_time)
  restarts: number
}

export interface KunPm2 {
  stopAll(): void
  startAll(): void
  // 杀掉守护进程并等它退出, 下一条 pm2 命令用当前 shell 的 node 拉起新的。只在我们的应用都删掉之后调
  restartDaemon(): Promise<void>
  save(): void
  list(): KunPm2Process[]
}

interface KunPm2Options {
  repoDir: string
  apps: readonly KunAppSpec[]
  // 执行一条命令, 输出照常打印, 失败时抛错
  run?: (command: string) => void
  // 执行一条命令并返回它的标准输出, 失败时抛错
  capture?: (command: string) => string
  // 守护进程的 pid (PM2_HOME 下的 pm2.pid), 没有在跑时为 null
  daemonPid?: () => number | null
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  // 等旧守护进程退出的上限
  daemonExitTimeoutMs?: number
}

const readDaemonPid = () => {
  const home = process.env.PM2_HOME ?? path.join(homedir(), '.pm2')
  try {
    const pid = Number(readFileSync(path.join(home, 'pm2.pid'), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const requireCjs = createRequire(import.meta.url)

export const kunEcosystemApps = (repoDir: string): KunAppSpec[] => {
  const file = path.join(repoDir, 'ecosystem.config.cjs')
  const { apps } = requireCjs(file) as { apps?: unknown }
  if (!Array.isArray(apps) || apps.length === 0) {
    throw new Error(`${file} 里没有 apps`)
  }
  return apps.map((raw) => {
    const app = raw as {
      name?: unknown
      instances?: unknown
      env?: { PORT?: unknown }
    }
    const port = Number(app.env?.PORT)
    const instances = app.instances ?? 1
    // 闸门要数出每个 app 有几个进程在线、逐个端口查健康, instances 写成 'max' 之类就数不出来
    if (
      typeof app.name !== 'string' ||
      !Number.isInteger(port) ||
      port <= 0 ||
      typeof instances !== 'number' ||
      !Number.isInteger(instances) ||
      instances < 1
    ) {
      throw new Error(
        `${file} 里的 app 须有 name、env.PORT 与正整数的 instances: ${JSON.stringify(
          { name: app.name, port: app.env?.PORT, instances: app.instances }
        )}`
      )
    }
    return { name: app.name, port, instances }
  })
}

// 守护进程没在跑时 pm2 会先拉起它, 往标准输出打几行「[PM2] Spawning PM2 daemon ...」, JSON 在最后一行
const parseJlist = (output: string): unknown[] => {
  const lastLine = output.trim().split('\n').at(-1) ?? ''
  let parsed: unknown = null
  try {
    parsed = JSON.parse(lastLine)
  } catch {
    // 落到下面报错
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `认不出 pm2 jlist 的输出, 最后一行开头是: ${lastLine.slice(0, 80)}`
    )
  }
  return parsed
}

export const createKunPm2 = ({
  repoDir,
  apps,
  run = (command) => {
    execSync(command, { cwd: repoDir, stdio: 'inherit' })
  },
  // jlist 每个进程都带着完整的环境变量 (实测一个约 9 KB), 17 个进程已过百 KB, 默认 1 MiB 的上限余量不大
  capture = (command) =>
    execSync(command, {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit']
    }),
  daemonPid = readDaemonPid,
  isAlive = isProcessAlive,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  daemonExitTimeoutMs = 60_000
}: KunPm2Options): KunPm2 => {
  const names = new Set(apps.map((app) => app.name))
  const cron = apps.find((app) => app.name.endsWith('-cron'))

  // 杀守护进程会连带杀掉它管的别的应用 (模块如 pm2-logrotate 随新守护进程自动拉起, 不算)
  const foreignApps = () =>
    parseJlist(capture('pm2 jlist')).flatMap((raw) => {
      const entry = raw as {
        name?: unknown
        pm2_env?: { pmx_module?: unknown }
      }
      return typeof entry.name === 'string' &&
        !names.has(entry.name) &&
        entry.pm2_env?.pmx_module !== true
        ? [entry.name]
        : []
    })

  const list = (): KunPm2Process[] =>
    parseJlist(capture('pm2 jlist')).flatMap((raw) => {
      const entry = raw as {
        name?: unknown
        pm_id?: unknown
        pm2_env?: {
          status?: unknown
          node_version?: unknown
          restart_time?: unknown
        }
      }
      if (
        typeof entry.name !== 'string' ||
        !names.has(entry.name) ||
        typeof entry.pm_id !== 'number'
      ) {
        return []
      }
      const {
        status,
        node_version: nodeVersion,
        restart_time: restarts
      } = entry.pm2_env ?? {}
      return [
        {
          pmId: entry.pm_id,
          name: entry.name,
          status: typeof status === 'string' ? status : 'unknown',
          nodeVersion: typeof nodeVersion === 'string' ? nodeVersion : null,
          restarts: typeof restarts === 'number' ? restarts : 0
        }
      ]
    })

  const hasPid = (name: string) =>
    capture(`pm2 pid ${name}`)
      .trim()
      .split(/\s+/)
      .some((pid) => Number(pid) > 0)

  return {
    // cron 进程先单独停: 它收到信号后等在途作业最多约 25 秒 (宽限 20 秒 + 收尾 5 秒, 见
    // server/cron.ts; ecosystem 的 kill_timeout 30 秒是兜底的 SIGKILL), 这段时间 web 仍在服务旧版本。
    // pnpm stop 按 ecosystem 并发删两个进程、等两者都退出才返回, 不先停 cron 的话这段等待会叠进
    // web 的停机窗口
    stopAll: () => {
      if (cron && hasPid(cron.name)) {
        run(`pm2 delete ${cron.name}`)
      }
      run('pnpm stop')
      // 调用方接着就要切换 current: 还有进程留在列表里的话, 它日后重启会跑到切换后的发布上
      const left = [...new Set(list().map((entry) => entry.name))]
      if (left.length > 0) {
        throw new Error(
          `pnpm stop 之后 PM2 里还有 ${left.join(', ')}, 不能切换 current`
        )
      }
    },
    startAll: () => run('pnpm start'),
    // 不用 pm2 update: 它在应用运行时存列表、杀守护进程、再从列表恢复, 11-27 生产 (PM2 7.0.1) 上
    // 恢复出来是空的, 旧守护进程退出之前还占着 web 的端口, 紧接着的回滚全部 listen 失败。这里只在我们的
    // 应用都删掉之后杀守护进程, 等它的 pid 消失, 不靠 dump 恢复: 调用方接着自己 pnpm start
    restartDaemon: async () => {
      const ours = [...new Set(list().map((entry) => entry.name))]
      if (ours.length > 0) {
        throw new Error(`PM2 里还有 ${ours.join(', ')}, 先删掉再重启守护进程`)
      }
      const foreign = [...new Set(foreignApps())]
      if (foreign.length > 0) {
        throw new Error(
          `PM2 还管着别的应用 (${foreign.join(', ')}), 不自动重启守护进程: 找个时间手动 pm2 update, 再重新部署`
        )
      }
      const pid = daemonPid()
      run('pm2 kill')
      if (pid === null) {
        return
      }
      for (let waited = 0; isAlive(pid); waited += 200) {
        if (waited >= daemonExitTimeoutMs) {
          throw new Error(
            `pm2 kill 之后 ${Math.round(daemonExitTimeoutMs / 1000)} 秒守护进程 (pid ${pid}) 还没有退出`
          )
        }
        await sleep(200)
      }
    },
    save: () => run('pm2 save'),
    list
  }
}
