import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KUN_DEFAULT_SMOKE, runCanary } from '../smoke'
import { kunReleaseGuardPath } from '../verify'
import { makeTempDir, removeTempDir } from './support/tempDir'
import type { RunCanaryOptions } from '../smoke'

const RELEASE_ID = '20261126030405-fc8b626'

// 假的 server.js: 与 Next 一样从 cwd 的 .env 补环境变量 (不覆盖已有的), 按 FAKE_MODE 演各种坏法。
// 把自己的 PID 写下来, 测试结束时按 PID 收尸 (正常情况下金丝雀已经停掉了它)
const FAKE_SERVER = `
const fs = require('fs')
const http = require('http')
for (const line of fs.readFileSync('.env', 'utf8').split('\\n')) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line)
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2]
  }
}
fs.writeFileSync('server.pid', String(process.pid))
const mode = process.env.FAKE_MODE
console.log('fake server mode ' + mode)
if (mode === 'crash') {
  console.error('fake boom')
  process.exit(3)
}
if (mode === 'escape') {
  try {
    require('zod')
  } catch (error) {
    console.log('zod ' + error.code)
  }
}
if (mode === 'next-config') {
  console.log('webpack hook ' + require('next/dist/server/config-utils.js'))
}
process.on('SIGTERM', () => {
  if (mode !== 'stubborn') {
    process.exit(0)
  }
})
if (mode === 'hang') {
  setInterval(() => {}, 1000)
} else {
  http
    .createServer((req, res) => {
      if (req.url === '/api/health') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ release: process.env.KUN_RELEASE_ID ?? null }))
        return
      }
      if (req.url === '/env') {
        const isolated =
          process.env.KUN_SMOKE_TEST_LEAK === undefined &&
          process.env.KUN_ENABLE_CRON === 'false' &&
          process.env.HOSTNAME === '127.0.0.1'
        res.statusCode = isolated ? 200 : 500
        res.end()
        return
      }
      res.statusCode = req.url === '/' ? 200 : req.url === '/moved' ? 308 : 404
      if (res.statusCode === 308) {
        res.setHeader('location', '/')
      }
      res.end('fake')
    })
    .listen(Number(process.env.PORT), process.env.HOSTNAME)
}
`

let dir: string

const writeEnv = (releaseId: string) =>
  fs.writeFileSync(path.join(dir, '.env'), `KUN_RELEASE_ID=${releaseId}\n`)

const canary = (mode: string, overrides: Partial<RunCanaryOptions> = {}) =>
  runCanary({
    releaseDir: dir,
    releaseId: RELEASE_ID,
    env: { FAKE_MODE: mode },
    checks: [{ path: '/', expectStatus: 200 }],
    guardPath: kunReleaseGuardPath,
    startTimeoutMs: 5000,
    requestTimeoutMs: 2000,
    ...overrides
  })

const leftovers = () =>
  fs.readdirSync(dir).filter((name) => name.startsWith('.kun-canary-'))

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const serverPid = () => {
  const file = path.join(dir, 'server.pid')
  return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : null
}

beforeEach(() => {
  dir = makeTempDir('smoke')
  fs.writeFileSync(path.join(dir, 'server.js'), FAKE_SERVER)
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}')
  writeEnv(RELEASE_ID)
})

afterEach(() => {
  vi.unstubAllEnvs()
  const pid = serverPid()
  if (pid !== null && isAlive(pid)) {
    process.kill(pid, 'SIGKILL')
  }
  removeTempDir(dir)
})

describe('KUN_DEFAULT_SMOKE', () => {
  it('only issues read-only GETs that expect 200', () => {
    expect(KUN_DEFAULT_SMOKE.map((check) => check.path)).toEqual([
      '/',
      '/galgame',
      '/login',
      '/sitemap.xml',
      '/robots.txt',
      '/_next/image?url=%2Flogo.webp&w=64&q=75'
    ])
    expect(KUN_DEFAULT_SMOKE.every((check) => check.expectStatus === 200)).toBe(
      true
    )
  })
})

describe('runCanary', () => {
  it('passes when the release reports its id and every check matches', async () => {
    // 部署进程环境里的东西不该漏进金丝雀: 它只认发布自己的 .env 与显式传入的变量
    vi.stubEnv('KUN_SMOKE_TEST_LEAK', 'leaked')
    const result = await canary('ok', {
      checks: [
        { path: '/', expectStatus: 200 },
        { path: '/env', expectStatus: 200 },
        // 不跟随跳转: 期望写的就是跳转本身
        { path: '/moved', expectStatus: 308 }
      ]
    })
    expect(result).toMatchObject({ ok: true, failures: [] })
    expect(result.output).toContain('fake server mode ok')
    expect(isAlive(serverPid() as number)).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('reports a check whose status does not match', async () => {
    const result = await canary('ok', {
      checks: [
        { path: '/missing', expectStatus: 200 },
        { path: '/', expectStatus: 200 }
      ]
    })
    expect(result.ok).toBe(false)
    expect(result.failures).toEqual(['GET /missing → 404，期望 200'])
  })

  it('fails without running the checks when the health route reports another release', async () => {
    writeEnv('20250101000000-0000000')
    const result = await canary('ok', {
      checks: [{ path: '/missing', expectStatus: 200 }]
    })
    expect(result.ok).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain('20250101000000-0000000')
    expect(result.failures[0]).toContain(`期望 ${RELEASE_ID}`)
  })

  it('fails early with the output when the server exits at start', async () => {
    const started = Date.now()
    const result = await canary('crash')
    expect(Date.now() - started).toBeLessThan(4000)
    expect(result.ok).toBe(false)
    expect(result.failures).toEqual(['进程在就绪之前退出 (退出码 3)'])
    expect(result.output).toContain('fake boom')
    expect(leftovers()).toEqual([])
  })

  it('gives up after the start timeout and stops the server', async () => {
    const result = await canary('hang', { startTimeoutMs: 800 })
    expect(result.ok).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatch(/^800 ms 内没有就绪/)
    expect(isAlive(serverPid() as number)).toBe(false)
    expect(leftovers()).toEqual([])
  })

  // 仿 Next 的 loadWebpackHook (见 verify.ts 的 KUN_EXPECTED_GUARD_ESCAPES): 拦下, 但不算失败
  it('does not fail on the expected escape of Next loading its webpack hook', async () => {
    fs.mkdirSync(path.join(dir, 'node_modules/next/dist/server'), {
      recursive: true
    })
    fs.writeFileSync(
      path.join(dir, 'node_modules/next/package.json'),
      '{"name":"next"}'
    )
    fs.writeFileSync(
      path.join(dir, 'node_modules/next/dist/server/config-utils.js'),
      "try { require.resolve('next/dist/compiled/webpack/webpack-lib') } catch (error) { module.exports = error.code }\n"
    )
    const result = await canary('next-config')
    expect(result).toMatchObject({ ok: true, failures: [] })
    expect(result.output).toContain('webpack hook MODULE_NOT_FOUND')
  })

  it('kills a server that ignores SIGTERM after the stop timeout', async () => {
    const result = await canary('stubborn', { stopTimeoutMs: 300 })
    expect(result).toMatchObject({ ok: true, failures: [] })
    expect(isAlive(serverPid() as number)).toBe(false)
  })

  // 临时目录在仓库的 node_modules/.cache 下: 发布里没有的 zod 会向上解析进仓库的 node_modules。
  // 守卫把它拦成找不到 (与生产上一样), 同时报出来
  it('blocks and reports a module the server resolves from outside the release', async () => {
    const result = await canary('escape')
    expect(result.output).toContain('zod MODULE_NOT_FOUND')
    expect(result.ok).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatch(/^模块解析逃出发布: zod → /)
    expect(result.failures[0]).toContain(
      `(来自 ${fs.realpathSync(path.join(dir, 'server.js'))})`
    )
    expect(leftovers()).toEqual([])
  })
})
