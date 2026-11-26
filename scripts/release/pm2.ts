// 部署与回滚对 PM2 的全部操作: 停、起、换守护进程的 Node、存进程列表、看每个进程的状态与 Node 版本。
// 应用的名字、端口与实例数只取 ecosystem.config.cjs, 闸门按它们核对进程
import { execSync } from 'child_process'
import { createRequire } from 'module'
import path from 'path'

export interface KunAppSpec {
  name: string
  port: number
  instances: number
}

export interface KunPm2Process {
  name: string
  status: string
  // 进程自己的 process.versions.node (不带 v)
  nodeVersion: string | null
}

export interface KunPm2 {
  stopAll(): void
  startAll(): void
  update(): void
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
    })
}: KunPm2Options): KunPm2 => {
  const names = new Set(apps.map((app) => app.name))
  const cron = apps.find((app) => app.name.endsWith('-cron'))

  const list = (): KunPm2Process[] =>
    parseJlist(capture('pm2 jlist')).flatMap((raw) => {
      const entry = raw as {
        name?: unknown
        pm2_env?: { status?: unknown; node_version?: unknown }
      }
      if (typeof entry.name !== 'string' || !names.has(entry.name)) {
        return []
      }
      const { status, node_version: nodeVersion } = entry.pm2_env ?? {}
      return [
        {
          name: entry.name,
          status: typeof status === 'string' ? status : 'unknown',
          nodeVersion: typeof nodeVersion === 'string' ? nodeVersion : null
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
    // 把列表存下、杀掉守护进程、用当前 shell 的 node 重新拉起并恢复列表里的进程
    update: () => run('pm2 update'),
    save: () => run('pm2 save'),
    list
  }
}
