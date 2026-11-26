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

const jlistEntry = (name: string, status: string, nodeVersion?: string) => ({
  pid: 1234,
  name,
  pm_id: 0,
  pm2_env: { status, node_version: nodeVersion, env: { SECRET: 'x' } }
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
      'pm2 jlist': JSON.stringify([jlistEntry('kun-touchgal-next', 'stopped')])
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
          jlistEntry('kun-touchgal-next', 'online', '26.12.1'),
          jlistEntry('kun-touchgal-next', 'launching', '26.12.1'),
          jlistEntry('someone-else', 'online', '24.0.0'),
          jlistEntry('kun-touchgal-next-cron', 'online')
        ])
      ].join('\n')
    })
    expect(createKunPm2({ repoDir, apps: APPS, ...shell }).list()).toEqual([
      { name: 'kun-touchgal-next', status: 'online', nodeVersion: '26.12.1' },
      {
        name: 'kun-touchgal-next',
        status: 'launching',
        nodeVersion: '26.12.1'
      },
      { name: 'kun-touchgal-next-cron', status: 'online', nodeVersion: null }
    ])
  })

  it('does not guess when jlist prints something else', () => {
    const shell = createShell({ 'pm2 jlist': '[PM2] something went wrong\n' })
    expect(() =>
      createKunPm2({ repoDir, apps: APPS, ...shell }).list()
    ).toThrow('pm2 jlist')
  })

  it('maps start, update and save to the commands', () => {
    const shell = createShell({})
    const pm2 = createKunPm2({ repoDir, apps: APPS, ...shell })
    pm2.startAll()
    pm2.update()
    pm2.save()
    expect(shell.commands).toEqual(['pnpm start', 'pm2 update', 'pm2 save'])
  })
})
