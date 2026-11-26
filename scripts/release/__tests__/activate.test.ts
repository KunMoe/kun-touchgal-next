import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activateRelease, kunFetchHealth, rollbackTo } from '../activate'
import {
  isReleaseId,
  kunReleaseLayoutFor,
  listReleases,
  readCurrentReleaseId,
  releaseDirOf,
  switchCurrentRelease,
  writeReleaseManifest
} from '../layout'
import { makeTempDir, removeTempDir } from './support/tempDir'
import type { ActivateDeps, KunHealth } from '../activate'
import type { ReleaseId, ReleaseLayout } from '../layout'
import type { KunAppSpec, KunPm2, KunPm2Process } from '../pm2'

const id = (value: string) => {
  if (!isReleaseId(value)) {
    throw new Error(`bad fixture id ${value}`)
  }
  return value
}

const R1 = id('20261101000000-aaaaaaa')
const R2 = id('20261102000000-bbbbbbb')
const R3 = id('20261103000000-ccccccc')
const R4 = id('20261104000000-ddddddd')
const R5 = id('20261105000000-eeeeeee')

const EXPECTED_NODE = '26.12.1'
const TIMEOUT_MS = 10_000
const APPS: KunAppSpec[] = [
  { name: 'kun-touchgal-next', port: 3000, instances: 3 },
  { name: 'kun-touchgal-next-cron', port: 3001, instances: 1 }
]

let root: string
let layout: ReleaseLayout

const addReleases = (...ids: ReleaseId[]) => {
  for (const releaseId of ids) {
    const dir = releaseDirOf(layout, releaseId)
    fs.mkdirSync(dir, { recursive: true })
    writeReleaseManifest(dir, {
      id: releaseId,
      gitSha: `${releaseId.slice(-7)}${'0'.repeat(33)}`,
      builtAt: '2026-11-26T00:00:00.000Z',
      node: `v${EXPECTED_NODE}`,
      nextBuildId: 'build-id',
      distDir: '.next-deploy'
    })
  }
}

const currentLabel = () => readCurrentReleaseId(layout) ?? 'legacy'

interface WorldOptions {
  // 测试开始时 PM2 上是否已有在跑的应用 (跑的是那时 current 指向的发布)
  running?: boolean
  daemonNode?: string
  // pm2 update 之后守护进程的 Node; 不给就不变
  nodeAfterUpdate?: string
  // 第 n 次 (从 1 数) 调用时抛错
  failStartAt?: number[]
  failStopAt?: number[]
  failSave?: boolean
  status?: (release: ReleaseId | null) => string
  // 这个发布的 cron 进程启动之后反复退出、又被 PM2 拉起: 状态一直是 online, 每看一次重启次数加一
  crashLoop?: (release: ReleaseId | null) => boolean
  // 默认: 进程在跑时回 200 与它启动时 current 指向的发布
  health?: (release: ReleaseId | null, port: number) => KunHealth | null
}

// 假的 PM2: 进程启动时记下 current 当时的指向 (真 PM2 的进程按启动那一刻的软链目标运行), 健康检查回的
// 是那个发布。每次调用前核对一次「进程在跑时 current 没有被换过」
const createWorld = (options: WorldOptions = {}) => {
  let clock = 0
  let daemonNode = options.daemonNode ?? EXPECTED_NODE
  let running: { release: ReleaseId | null; node: string } | null =
    options.running === false
      ? null
      : { release: readCurrentReleaseId(layout), node: daemonNode }
  const calls: string[] = []
  const violations: string[] = []
  const logs: string[] = []
  const counts = { start: 0, stop: 0 }
  // 每次启动都分配新的 pm_id (真 PM2 会复用删掉的编号; 闸门每次都新记基线, 两种都一样)
  let nextPmId = 0
  const spawn = () =>
    APPS.flatMap((app) =>
      Array.from({ length: app.instances }, () => ({
        pmId: nextPmId++,
        name: app.name,
        restarts: 0
      }))
    )
  let instances = running ? spawn() : []

  const enter = (method: string, record = true) => {
    if (running && readCurrentReleaseId(layout) !== running.release) {
      violations.push(
        `${method}: current 换成了 ${currentLabel()}, 进程仍在 ${running.release ?? 'legacy'} 上`
      )
    }
    if (record) {
      calls.push(`${method}@${currentLabel()}`)
    }
  }

  const pm2: KunPm2 = {
    stopAll: () => {
      enter('stopAll')
      counts.stop += 1
      if (options.failStopAt?.includes(counts.stop)) {
        throw new Error('pnpm stop 失败')
      }
      running = null
      instances = []
    },
    startAll: () => {
      enter('startAll')
      counts.start += 1
      running = { release: readCurrentReleaseId(layout), node: daemonNode }
      instances = spawn()
      if (options.failStartAt?.includes(counts.start)) {
        throw new Error('pnpm start 失败')
      }
    },
    update: () => {
      enter('update')
      daemonNode = options.nodeAfterUpdate ?? daemonNode
      if (running) {
        running = { release: readCurrentReleaseId(layout), node: daemonNode }
        // 恢复出来的进程沿用原来的 pm_id、重启次数还多了一次: 比真 PM2 (重新编号、从 0 数起) 苛刻,
        // 闸门不在 update 之后重新记基线就会误判
        instances = instances.map((instance) => ({
          ...instance,
          restarts: instance.restarts + 1
        }))
      }
    },
    save: () => {
      enter('save')
      if (options.failSave) {
        throw new Error('pm2 save 失败')
      }
    },
    list: () => {
      enter('list', false)
      const live = running
      if (!live) {
        return []
      }
      const status = options.status?.(live.release) ?? 'online'
      if (options.crashLoop?.(live.release)) {
        instances = instances.map((instance) =>
          instance.name.endsWith('-cron')
            ? { ...instance, restarts: instance.restarts + 1 }
            : instance
        )
      }
      return instances.map((instance): KunPm2Process => ({
        ...instance,
        status,
        nodeVersion: live.node
      }))
    }
  }

  const deps: ActivateDeps = {
    layout,
    pm2,
    apps: APPS,
    expectedNode: EXPECTED_NODE,
    fetchHealth: async (port) => {
      if (!running || !APPS.some((app) => app.port === port)) {
        return null
      }
      return options.health
        ? options.health(running.release, port)
        : { status: 200, release: running.release }
    },
    sleep: async (ms) => {
      clock += ms
    },
    log: (message) => {
      logs.push(message)
    },
    now: () => clock,
    gateTimeoutMs: TIMEOUT_MS,
    pollMs: 1000
  }

  return {
    deps,
    calls,
    violations,
    logs,
    running: () => running,
    restarts: () => instances.map((instance) => instance.restarts),
    clock: () => clock
  }
}

// 某个发布起来了但不应答
const silent =
  (broken: ReleaseId | null) =>
  (release: ReleaseId | null): KunHealth | null =>
    release === broken ? null : { status: 200, release }

beforeEach(() => {
  root = makeTempDir('activate')
  layout = kunReleaseLayoutFor(root)
})

afterEach(() => {
  removeTempDir(root)
})

describe('activateRelease', () => {
  it('switches current only after every app is deleted, then saves and prunes', async () => {
    addReleases(R1, R2, R3, R4, R5)
    switchCurrentRelease(layout, R4)
    const world = createWorld()

    const result = await activateRelease(world.deps, R5)

    expect(result).toEqual({
      ok: true,
      id: R5,
      previous: R4,
      pruned: [R2, R1]
    })
    expect(world.calls).toEqual([
      `stopAll@${R4}`,
      `startAll@${R5}`,
      `save@${R5}`
    ])
    expect(world.violations).toEqual([])
    expect(world.running()).toEqual({ release: R5, node: EXPECTED_NODE })
    expect(readCurrentReleaseId(layout)).toBe(R5)
    expect(listReleases(layout).map((manifest) => manifest.id)).toEqual([
      R5,
      R4,
      R3
    ])
  })

  it('rolls back to the previous release when the new one never reports its own id', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R1)
    // 200 但 release 不对: 例如发布的 .env 里没写上 KUN_RELEASE_ID
    const world = createWorld({
      health: (release) => ({
        status: 200,
        release: release === R2 ? null : release
      })
    })

    const result = await activateRelease(world.deps, R2)

    expect(result).toMatchObject({ ok: false, id: R2, rolledBackTo: R1 })
    expect(result).not.toHaveProperty('rollbackFailed')
    expect(!result.ok && result.reason).toContain('release=null')
    expect(world.calls).toEqual([
      `stopAll@${R1}`,
      `startAll@${R2}`,
      `stopAll@${R2}`,
      `startAll@${R1}`,
      `save@${R1}`
    ])
    expect(world.violations).toEqual([])
    expect(world.running()?.release).toBe(R1)
    expect(world.clock()).toBeGreaterThanOrEqual(TIMEOUT_MS)
    // 没上线的发布留着备查
    expect(fs.existsSync(releaseDirOf(layout, R2))).toBe(true)
  })

  it('removes current after a failed first cutover so the ecosystem falls back to the legacy build', async () => {
    addReleases(R1)
    const world = createWorld({ health: silent(R1) })

    const result = await activateRelease(world.deps, R1)

    expect(result).toMatchObject({ ok: false, id: R1, rolledBackTo: null })
    expect(result).not.toHaveProperty('rollbackFailed')
    expect(!result.ok && result.reason).toContain('没有应答')
    expect(fs.existsSync(layout.currentLink)).toBe(false)
    expect(world.calls).toEqual([
      'stopAll@legacy',
      `startAll@${R1}`,
      `stopAll@${R1}`,
      'startAll@legacy',
      'save@legacy'
    ])
    expect(world.violations).toEqual([])
    expect(world.running()?.release).toBeNull()
  })

  it('counts a legacy build that predates /api/health (404) as up after falling back', async () => {
    addReleases(R1)
    const world = createWorld({
      health: (release) =>
        release === null ? { status: 404, release: null } : null
    })

    const result = await activateRelease(world.deps, R1)

    expect(result).toMatchObject({ ok: false, id: R1, rolledBackTo: null })
    expect(result).not.toHaveProperty('rollbackFailed')
    expect(world.running()?.release).toBeNull()
  })

  it('runs pm2 update once when the processes are on another Node and passes once they are not', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R1)
    const world = createWorld({
      daemonNode: '26.3.1',
      nodeAfterUpdate: EXPECTED_NODE
    })

    const result = await activateRelease(world.deps, R2)

    expect(result).toMatchObject({ ok: true, id: R2, previous: R1 })
    expect(world.calls).toEqual([
      `stopAll@${R1}`,
      `startAll@${R2}`,
      `update@${R2}`,
      `save@${R2}`
    ])
    expect(world.running()).toEqual({ release: R2, node: EXPECTED_NODE })
    // 恢复出来的进程带着更多的重启次数, 不算等待期间的重启
    expect(world.restarts().every((count) => count === 1)).toBe(true)
  })

  it('fails and rolls back when pm2 update does not bring the declared Node', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R1)
    const world = createWorld({ daemonNode: '26.3.1' })

    const result = await activateRelease(world.deps, R2)

    expect(result).toMatchObject({ ok: false, id: R2, rolledBackTo: R1 })
    expect(!result.ok && result.reason).toContain('26.3.1')
    expect(!result.ok && result.reason).toContain(EXPECTED_NODE)
    expect(world.calls).toEqual([
      `stopAll@${R1}`,
      `startAll@${R2}`,
      `update@${R2}`,
      `stopAll@${R2}`,
      `startAll@${R1}`,
      `save@${R1}`
    ])
    expect(readCurrentReleaseId(layout)).toBe(R1)
  })

  it('fails without waiting for the deadline once PM2 gives up on a process', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R1)
    const world = createWorld({
      status: (release) => (release === R2 ? 'errored' : 'online')
    })

    const result = await activateRelease(world.deps, R2)

    expect(result).toMatchObject({ ok: false, rolledBackTo: R1 })
    expect(!result.ok && result.reason).toContain('errored')
    expect(world.clock()).toBeLessThan(TIMEOUT_MS)
  })

  it('fails within a few polls when an app keeps restarting but never reaches errored', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R1)
    // cron 在 Next 起来之后才退出 (超过 min_uptime): PM2 一直把它拉起, 它的端口一直不应答
    const world = createWorld({
      crashLoop: (release) => release === R2,
      health: (release, port) =>
        release === R2 && port === 3001 ? null : { status: 200, release }
    })

    const result = await activateRelease(world.deps, R2)

    expect(result).toMatchObject({ ok: false, id: R2, rolledBackTo: R1 })
    expect(result).not.toHaveProperty('rollbackFailed')
    expect(!result.ok && result.reason).toContain(
      'kun-touchgal-next-cron 在等待期间重启了'
    )
    expect(world.clock()).toBeLessThanOrEqual(3000)
    expect(world.calls).toEqual([
      `stopAll@${R1}`,
      `startAll@${R2}`,
      `stopAll@${R2}`,
      `startAll@${R1}`,
      `save@${R1}`
    ])
    expect(world.violations).toEqual([])
  })

  it('reports a rollback target that keeps restarting instead of waiting out the deadline', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R1)
    const world = createWorld({ crashLoop: () => true, health: () => null })

    const result = await activateRelease(world.deps, R2)

    expect(result).toMatchObject({ ok: false, rolledBackTo: R1 })
    expect(!result.ok && result.rollbackFailed).toContain('重启了')
    expect(world.calls.at(-1)).toBe(`save@${R1}`)
    expect(world.clock()).toBeLessThanOrEqual(6000)
  })

  it('treats a throwing start like a failed gate', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R1)
    // 第一次 pnpm start 起了一部分进程之后失败
    const world = createWorld({ failStartAt: [1] })

    const result = await activateRelease(world.deps, R2)

    expect(result).toMatchObject({
      ok: false,
      id: R2,
      rolledBackTo: R1,
      reason: 'pnpm start 失败'
    })
    expect(result).not.toHaveProperty('rollbackFailed')
    expect(world.calls).toEqual([
      `stopAll@${R1}`,
      `startAll@${R2}`,
      `stopAll@${R2}`,
      `startAll@${R1}`,
      `save@${R1}`
    ])
    expect(world.violations).toEqual([])
  })

  it('does not switch when stopping fails and brings the old release back up', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R1)
    const world = createWorld({ failStopAt: [1] })

    const result = await activateRelease(world.deps, R2)

    expect(result).toMatchObject({
      ok: false,
      rolledBackTo: R1,
      reason: 'pnpm stop 失败'
    })
    expect(world.calls).toEqual([
      `stopAll@${R1}`,
      `stopAll@${R1}`,
      `startAll@${R1}`,
      `save@${R1}`
    ])
    expect(world.violations).toEqual([])
  })

  it('reports a rollback that cannot start instead of throwing', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R1)
    const world = createWorld({ health: silent(R2), failStartAt: [2] })

    const result = await activateRelease(world.deps, R2)

    expect(result).toMatchObject({ ok: false, id: R2, rolledBackTo: R1 })
    expect(!result.ok && result.rollbackFailed).toContain('pnpm start 失败')
    expect(!result.ok && result.rollbackFailed).toContain(
      `current 现在是 ${R1}`
    )
    expect(world.violations).toEqual([])
  })

  it('reports a rollback whose health check does not pass, and still saves', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R1)
    const world = createWorld({ health: () => null })

    const result = await activateRelease(world.deps, R2)

    expect(result).toMatchObject({ ok: false, rolledBackTo: R1 })
    expect(!result.ok && result.rollbackFailed).toContain('健康检查没有通过')
    expect(world.calls.at(-1)).toBe(`save@${R1}`)
    // 回滚的健康检查有自己的时限, 不会无限等
    expect(world.clock()).toBeLessThan(3 * TIMEOUT_MS)
  })

  it('keeps a passed activation when pm2 save fails', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R1)
    const world = createWorld({ failSave: true })

    const result = await activateRelease(world.deps, R2)

    expect(result).toMatchObject({ ok: true, id: R2 })
    expect(readCurrentReleaseId(layout)).toBe(R2)
    expect(world.logs.some((line) => line.includes('pm2 save 失败'))).toBe(true)
  })
})

describe('rollbackTo', () => {
  it('defaults to the newest release older than the live one and prunes nothing', async () => {
    // R3 是比在线发布更新、没通过闸门的那一个
    addReleases(R1, R2, R3, R4)
    switchCurrentRelease(layout, R3)
    const world = createWorld()

    const result = await rollbackTo(world.deps)

    expect(result).toEqual({ ok: true, id: R2, previous: R3, pruned: [] })
    expect(world.calls).toEqual([
      `stopAll@${R3}`,
      `startAll@${R2}`,
      `save@${R2}`
    ])
    expect(world.violations).toEqual([])
    expect(listReleases(layout)).toHaveLength(4)
  })

  it('takes an explicit target, also a newer one', async () => {
    addReleases(R1, R2, R3)
    switchCurrentRelease(layout, R1)
    const world = createWorld()

    const result = await rollbackTo(world.deps, R3)

    expect(result).toEqual({ ok: true, id: R3, previous: R1, pruned: [] })
    expect(readCurrentReleaseId(layout)).toBe(R3)
  })

  it('switches back to the live release when the target fails the gate', async () => {
    addReleases(R1, R2)
    switchCurrentRelease(layout, R2)
    const world = createWorld({ health: silent(R1) })

    const result = await rollbackTo(world.deps)

    expect(result).toMatchObject({ ok: false, id: R1, rolledBackTo: R2 })
    expect(result).not.toHaveProperty('rollbackFailed')
    expect(readCurrentReleaseId(layout)).toBe(R2)
    expect(world.running()?.release).toBe(R2)
    expect(world.calls.at(-1)).toBe(`save@${R2}`)
    expect(world.violations).toEqual([])
  })

  it('refuses before touching PM2 when there is nothing to roll back to', async () => {
    addReleases(R1, R2)
    const world = createWorld()
    // 旧布局在线
    await expect(rollbackTo(world.deps)).rejects.toThrow('旧构建')

    switchCurrentRelease(layout, R1)
    await expect(rollbackTo(world.deps)).rejects.toThrow('更早的发布')
    await expect(rollbackTo(world.deps, R1)).rejects.toThrow('就是在线的发布')
    await expect(rollbackTo(world.deps, R3)).rejects.toThrow('不在')
    expect(world.calls).toEqual([])
  })
})

describe('kunFetchHealth', () => {
  const listen = async (handler: http.RequestListener) => {
    const server = http.createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { server, port: (server.address() as AddressInfo).port }
  }
  const close = (server: http.Server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))

  it('reads the status and the release id', async () => {
    const { server, port } = await listen((req, res) => {
      if (req.url === '/api/health') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ release: R1 }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    try {
      expect(await kunFetchHealth(port)).toEqual({ status: 200, release: R1 })
    } finally {
      await close(server)
    }
  })

  it('keeps the status when the body is not JSON', async () => {
    const { server, port } = await listen((req, res) => {
      res.statusCode = 502
      res.end('<html>Bad Gateway</html>')
    })
    try {
      expect(await kunFetchHealth(port)).toEqual({ status: 502, release: null })
    } finally {
      await close(server)
    }
  })

  it('is null when nothing listens on the port', async () => {
    const { server, port } = await listen(() => {})
    await close(server)
    expect(await kunFetchHealth(port)).toBeNull()
  })
})
