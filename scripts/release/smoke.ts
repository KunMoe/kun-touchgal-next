// 金丝雀: 在停掉线上进程之前, 把刚组装好的发布在备用端口上整个跑起来, 打几条只读的请求。
//
// 子进程的环境刻意只给 PATH、HOME 与调用方显式传的几项, 不继承部署进程的环境: 这样它与 PM2 拉起的
// 应用一样只从发布自己的 .env 取配置, .env 写错 (比如 KUN_RELEASE_ID 不对) 在这里就现形。
// 带着 guard.mjs 跑: 发布里缺的模块若在运行期才被解析到发布之外, 这里报出来。
// 除了这几条 GET, 不做任何有副作用的事: 不开 cron, 不访问详情页 (会计浏览量), 不发 POST
import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { pathToFileURL } from 'url'
import { formatKunGuardEscapes, readKunGuardReport } from './verify'

export interface SmokeCheck {
  path: string
  expectStatus: number
}

export const KUN_DEFAULT_SMOKE: SmokeCheck[] = [
  // 首页: 服务端渲染要读库与 Redis, 发布 .env 里的连接配置或数据层坏了这里先红
  { path: '/', expectStatus: 200 },
  // 作品列表: 列表查询与卡片 (启用 Meilisearch 时还有召回)
  { path: '/galgame', expectStatus: 200 },
  // 不读业务数据的页面: 与上面两条对照, 区分「渲染链路坏了」与「数据层坏了」
  { path: '/login', expectStatus: 200 },
  // 运行期生成的 sitemap (server/sitemap/, 构建期不查库), 只有跑起来才测得到
  { path: '/sitemap.xml', expectStatus: 200 },
  // 由 config/routePolicy.ts 派生的 robots
  { path: '/robots.txt', expectStatus: 200 },
  // 图片优化要加载 sharp 的原生扩展, 外部包里最容易缺平台二进制的就是它
  { path: '/_next/image?url=%2Flogo.webp&w=64&q=75', expectStatus: 200 }
]

export interface RunCanaryOptions {
  releaseDir: string
  releaseId: string
  // 子进程环境里额外的变量 (盖过发布 .env 里的同名项)
  env: Record<string, string>
  checks: SmokeCheck[]
  guardPath: string
  startTimeoutMs?: number
  requestTimeoutMs?: number
  host?: string
  // 停止时 SIGTERM 之后等多久再 SIGKILL
  stopTimeoutMs?: number
}

export interface CanaryResult {
  ok: boolean
  failures: string[]
  // 子进程标准输出与标准错误的最后若干行, 失败时给人看
  output: string
}

const OUTPUT_LINES = 200
const POLL_MS = 500
// 进程退出之后再等一会儿它的输出管道读完, 启动即崩的报错就在最后几行里
const DRAIN_MS = 1000

const TIMED_OUT = Symbol('timed out')

// 不留下悬着的定时器: 否则金丝雀结束后命令行还要空等到它到期
const within = async <T>(
  promise: Promise<T>,
  ms: number
): Promise<T | typeof TIMED_OUT> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms))
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

// 先在 0 号端口上监听再关掉, 拿到一个此刻空闲的端口
const pickFreePort = (host: string) =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error(`拿不到 ${host} 上的空闲端口`))
        }
      })
    })
  })

const describeError = (error: unknown) => {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ''
    return `${error.message}${cause}`
  }
  return String(error)
}

const createOutputTail = (max: number) => {
  const lines: string[] = []
  const add = (line: string) => {
    lines.push(line)
    if (lines.length > max) {
      lines.splice(0, lines.length - max)
    }
  }
  // 每个流各自拼行, 两个流的半行不会互相拼到一起
  const sink = () => {
    let partial = ''
    return {
      write(chunk: string) {
        const parts = (partial + chunk).split('\n')
        partial = parts.pop() ?? ''
        parts.forEach(add)
      },
      flush() {
        if (partial) {
          add(partial)
          partial = ''
        }
      }
    }
  }
  return { sink, text: () => lines.join('\n') }
}

type HealthReading =
  { status: number; release: string | null } | { error: string }

const readHealth = async (
  url: string,
  timeoutMs: number
): Promise<HealthReading> => {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(1, timeoutMs))
    })
    const body = await res.text()
    let release: unknown = null
    try {
      release = (JSON.parse(body) as { release?: unknown }).release ?? null
    } catch {
      release = null
    }
    return {
      status: res.status,
      release: typeof release === 'string' ? release : null
    }
  } catch (error) {
    return { error: describeError(error) }
  }
}

export const runCanary = async (
  options: RunCanaryOptions
): Promise<CanaryResult> => {
  const {
    releaseId,
    checks,
    startTimeoutMs = 90_000,
    requestTimeoutMs = 30_000,
    host = '127.0.0.1',
    stopTimeoutMs = 10_000
  } = options
  // 子进程的 cwd 就是发布目录, 相对路径交给守卫会按那个 cwd 再解析一遍
  const releaseDir = path.resolve(options.releaseDir)
  const guardPath = path.resolve(options.guardPath)
  if (!fs.existsSync(path.join(releaseDir, 'server.js'))) {
    throw new Error(`${releaseDir} 下没有 server.js, 不是发布目录`)
  }
  if (!fs.existsSync(guardPath)) {
    throw new Error(`找不到模块解析守卫 ${guardPath}`)
  }

  const port = await pickFreePort(host)
  const base = `http://${host}:${port}`
  const report = path.join(
    releaseDir,
    `.kun-canary-guard-${process.pid}-${crypto.randomBytes(4).toString('hex')}.jsonl`
  )
  const env: Record<string, string> = {}
  for (const key of ['PATH', 'HOME']) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  Object.assign(env, options.env, {
    PORT: String(port),
    HOSTNAME: host,
    KUN_ENABLE_CRON: 'false',
    KUN_RELEASE_GUARD_ROOT: releaseDir,
    KUN_RELEASE_GUARD_REPORT: report
  })

  const failures: string[] = []
  const output = createOutputTail(OUTPUT_LINES)
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(guardPath).href, 'server.js'],
    {
      cwd: releaseDir,
      // 不含 NODE_ENV: standalone 的 server.js 自己设为 production
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const sinks = [output.sink(), output.sink()] as const
  child.stdout.setEncoding('utf8').on('data', (chunk) => sinks[0].write(chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk) => sinks[1].write(chunk))

  // 子进程的回调里改写, 不让 TS 把它收窄成初始的 null
  let exitInfo = null as string | null
  const exited = new Promise<string>((resolve) => {
    const settle = (info: string) => {
      if (exitInfo === null) {
        exitInfo = info
        resolve(info)
      }
    }
    child.once('exit', (code, signal) =>
      settle(signal ? `信号 ${signal}` : `退出码 ${code}`)
    )
    // on 而不是 once: 起不来之后再 kill 还会报一次 error, 没有监听就会把部署进程带崩
    child.on('error', (error) => settle(`启动失败: ${error.message}`))
  })
  const closed = new Promise<void>((resolve) => child.once('close', resolve))

  try {
    // 就绪: /api/health 回 200 且发布 id 对得上。回的是别的发布说明发布的 .env 不对, 不再等
    const deadline = Date.now() + startTimeoutMs
    let ready = false
    let last = '还没有应答'
    while (exitInfo === null) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        failures.push(
          `${startTimeoutMs} ms 内没有就绪 (GET /api/health 最后一次: ${last})`
        )
        break
      }
      const health = await readHealth(
        `${base}/api/health`,
        Math.min(requestTimeoutMs, remaining)
      )
      if ('error' in health) {
        last = health.error
      } else if (health.status !== 200) {
        last = `HTTP ${health.status}`
      } else if (health.release === releaseId) {
        ready = true
        break
      } else {
        failures.push(
          `GET /api/health 回的发布是 ${health.release ?? 'null'}，期望 ${releaseId} (发布 .env 里的 KUN_RELEASE_ID 不对)`
        )
        break
      }
      await within(exited, Math.min(POLL_MS, deadline - Date.now()))
    }
    if (!ready && failures.length === 0) {
      failures.push(`进程在就绪之前退出 (${exitInfo})`)
    }

    if (ready) {
      for (const check of checks) {
        try {
          const res = await fetch(`${base}${check.path}`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(requestTimeoutMs)
          })
          await res.arrayBuffer()
          if (res.status !== check.expectStatus) {
            failures.push(
              `GET ${check.path} → ${res.status}，期望 ${check.expectStatus}`
            )
          }
        } catch (error) {
          failures.push(`GET ${check.path} 失败: ${describeError(error)}`)
        }
      }
      if (exitInfo !== null) {
        failures.push(`进程在冒烟期间退出 (${exitInfo})`)
      }
    }
  } finally {
    if (exitInfo === null) {
      child.kill('SIGTERM')
      if ((await within(exited, stopTimeoutMs)) === TIMED_OUT) {
        child.kill('SIGKILL')
        await exited
      }
    }
    await within(closed, DRAIN_MS)
    // 它派生的进程若还握着管道, 管道不关, 部署进程就退不了
    child.stdout.destroy()
    child.stderr.destroy()
    sinks.forEach((sink) => sink.flush())
  }

  try {
    const escapes = readKunGuardReport(report)
    if (escapes === null) {
      failures.push(
        '模块解析守卫没有生效 (没有生成报告文件), 无法确认运行期的解析都在发布里面'
      )
    } else {
      for (const line of formatKunGuardEscapes(escapes)) {
        failures.push(`模块解析逃出发布: ${line}`)
      }
    }
  } finally {
    fs.rmSync(report, { force: true })
  }

  return { ok: failures.length === 0, failures, output: output.text() }
}
