import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'
import { createKunPm2, kunEcosystemApps } from '../pm2'
import { makeTempDir, removeTempDir } from './support/tempDir'
import type { KunAppSpec } from '../pm2'

const repoDir = fileURLToPath(new URL('../../../', import.meta.url))

const APPS: KunAppSpec[] = [
  { name: 'kun-touchgal-next', port: 3000, instances: 2 },
  { name: 'kun-touchgal-next-cron', port: 3001, instances: 1 }
]

const jlistEntry = (
  pmId: number,
  name: string,
  status: string,
  nodeVersion?: string,
  restarts?: number
) => ({
  pid: 1234,
  name,
  pm_id: pmId,
  pm2_env: {
    status,
    node_version: nodeVersion,
    restart_time: restarts,
    env: { SECRET: 'x' }
  }
})

// 假的命令执行: 记下每条命令, 按命令返回预设的标准输出
const createShell = (outputs: Record<string, string | string[]>) => {
  const commands: string[] = []
  const queues = new Map(
    Object.entries(outputs).map(([command, output]) => [
      command,
      Array.isArray(output) ? [...output] : [output]
    ])
  )
  const take = (command: string) => {
    const queue = queues.get(command)
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected capture: ${command}`)
    }
    return queue.length > 1 ? queue.shift()! : queue[0]
  }
  return {
    commands,
    run: (command: string) => {
      commands.push(command)
    },
    capture: (command: string) => {
      commands.push(command)
      return take(command)
    }
  }
}

let tempDir: string | undefined

afterEach(() => {
  if (tempDir) {
    removeTempDir(tempDir)
    tempDir = undefined
  }
})

describe('kunEcosystemApps', () => {
  it('reads names, ports and instance counts from the repo ecosystem', () => {
    expect(kunEcosystemApps(repoDir)).toEqual([
      { name: 'kun-touchgal-next', port: 3000, instances: 16 },
      { name: 'kun-touchgal-next-cron', port: 3001, instances: 1 }
    ])
  })

  it('refuses an instance count the gate cannot count', () => {
    tempDir = makeTempDir('pm2')
    fs.writeFileSync(
      path.join(tempDir, 'ecosystem.config.cjs'),
      "module.exports = { apps: [{ name: 'web', instances: 'max', env: { PORT: 3000 } }] }\n"
    )
    expect(() => kunEcosystemApps(tempDir!)).toThrow('instances')
  })
})

describe('createKunPm2', () => {
  it('deletes a running cron first, then stops everything and checks nothing is left', () => {
    const shell = createShell({
      'pm2 pid kun-touchgal-next-cron': '4321\n',
      'pm2 jlist': '[]\n'
    })
    createKunPm2({ repoDir, apps: APPS, ...shell }).stopAll()
    expect(shell.commands).toEqual([
      'pm2 pid kun-touchgal-next-cron',
      'pm2 delete kun-touchgal-next-cron',
      'pnpm stop',
      'pm2 jlist'
    ])
  })

  it('goes straight to pnpm stop when the cron app has no running process', () => {
    // 不存在的 app 输出一个空行, 停下的是 0
    for (const pid of ['\n', '0\n']) {
      const shell = createShell({
        'pm2 pid kun-touchgal-next-cron': pid,
        'pm2 jlist': '[]\n'
      })
      createKunPm2({ repoDir, apps: APPS, ...shell }).stopAll()
      expect(shell.commands).toEqual([
        'pm2 pid kun-touchgal-next-cron',
        'pnpm stop',
        'pm2 jlist'
      ])
    }
  })

  it('throws when one of our apps is still listed after stopping', () => {
    const shell = createShell({
      'pm2 pid kun-touchgal-next-cron': '\n',
      'pm2 jlist': JSON.stringify([
        jlistEntry(0, 'kun-touchgal-next', 'stopped')
      ])
    })
    expect(() =>
      createKunPm2({ repoDir, apps: APPS, ...shell }).stopAll()
    ).toThrow('kun-touchgal-next')
  })

  it('lists only our apps and reads past the daemon start banner', () => {
    const shell = createShell({
      'pm2 jlist': [
        '\u001b[32m[PM2] \u001b[39mSpawning PM2 daemon with pm2_home=/x',
        '\u001b[32m[PM2] \u001b[39mPM2 Successfully daemonized',
        JSON.stringify([
          jlistEntry(3, 'kun-touchgal-next', 'online', '26.12.1', 0),
          jlistEntry(4, 'kun-touchgal-next', 'launching', '26.12.1', 2),
          jlistEntry(5, 'someone-else', 'online', '24.0.0', 0),
          jlistEntry(6, 'kun-touchgal-next-cron', 'online')
        ])
      ].join('\n')
    })
    expect(createKunPm2({ repoDir, apps: APPS, ...shell }).list()).toEqual([
      {
        pmId: 3,
        name: 'kun-touchgal-next',
        status: 'online',
        nodeVersion: '26.12.1',
        restarts: 0
      },
      {
        pmId: 4,
        name: 'kun-touchgal-next',
        status: 'launching',
        nodeVersion: '26.12.1',
        restarts: 2
      },
      // 没有 node_version / restart_time 的条目
      {
        pmId: 6,
        name: 'kun-touchgal-next-cron',
        status: 'online',
        nodeVersion: null,
        restarts: 0
      }
    ])
  })

  it('does not guess when jlist prints something else', () => {
    const shell = createShell({ 'pm2 jlist': '[PM2] something went wrong\n' })
    expect(() =>
      createKunPm2({ repoDir, apps: APPS, ...shell }).list()
    ).toThrow('pm2 jlist')
  })

  it('maps start and save to the commands', () => {
    const shell = createShell({})
    const pm2 = createKunPm2({ repoDir, apps: APPS, ...shell })
    pm2.startAll()
    pm2.save()
    expect(shell.commands).toEqual(['pnpm start', 'pm2 save'])
  })
})

describe('restartDaemon', () => {
  const moduleEntry = {
    name: 'pm2-logrotate',
    pm_id: 0,
    pm2_env: { status: 'online', pmx_module: true }
  }
  // 守护进程 4242 在 pm2 kill 之后第 aliveChecks 次检查时才退出
  const daemon = (aliveChecks: number) => {
    let checks = 0
    return {
      daemonPid: () => 4242,
      isAlive: (pid: number) => {
        expect(pid).toBe(4242)
        checks += 1
        return checks < aliveChecks
      },
      sleeps: [] as number[],
      checks: () => checks
    }
  }

  it('kills the daemon and waits until its pid is gone, keeping modules out of the way', async () => {
    const shell = createShell({ 'pm2 jlist': JSON.stringify([moduleEntry]) })
    const d = daemon(4)
    const pm2 = createKunPm2({
      repoDir,
      apps: APPS,
      ...shell,
      ...d,
      sleep: async (ms) => {
        d.sleeps.push(ms)
      }
    })

    await pm2.restartDaemon()

    expect(shell.commands).toEqual(['pm2 jlist', 'pm2 jlist', 'pm2 kill'])
    expect(d.checks()).toBe(4)
    expect(d.sleeps).toEqual([200, 200, 200])
  })

  it('refuses while our apps are still in PM2', async () => {
    const shell = createShell({
      'pm2 jlist': JSON.stringify([
        jlistEntry(1, 'kun-touchgal-next-cron', 'stopping')
      ])
    })
    const pm2 = createKunPm2({ repoDir, apps: APPS, ...shell, ...daemon(1) })

    await expect(pm2.restartDaemon()).rejects.toThrow('kun-touchgal-next-cron')
    expect(shell.commands).not.toContain('pm2 kill')
  })

  it("refuses when the daemon also manages someone else's app", async () => {
    const shell = createShell({
      'pm2 jlist': JSON.stringify([
        moduleEntry,
        jlistEntry(1, 'other-app', 'online')
      ])
    })
    const pm2 = createKunPm2({ repoDir, apps: APPS, ...shell, ...daemon(1) })

    await expect(pm2.restartDaemon()).rejects.toThrow('other-app')
    expect(shell.commands).not.toContain('pm2 kill')
  })

  it('throws when the old daemon outlives the timeout', async () => {
    const shell = createShell({ 'pm2 jlist': '[]' })
    const pm2 = createKunPm2({
      repoDir,
      apps: APPS,
      ...shell,
      daemonPid: () => 4242,
      isAlive: () => true,
      sleep: async () => {},
      daemonExitTimeoutMs: 1000
    })

    await expect(pm2.restartDaemon()).rejects.toThrow('4242')
    expect(shell.commands).toContain('pm2 kill')
  })

  it('only kills when no daemon pid is on record', async () => {
    const shell = createShell({ 'pm2 jlist': '[]' })
    const pm2 = createKunPm2({
      repoDir,
      apps: APPS,
      ...shell,
      daemonPid: () => null,
      isAlive: () => {
        throw new Error('should not check')
      }
    })

    await pm2.restartDaemon()
    expect(shell.commands).toEqual(['pm2 jlist', 'pm2 jlist', 'pm2 kill'])
  })
})
