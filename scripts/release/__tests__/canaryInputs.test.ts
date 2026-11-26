import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { kunCanaryEnv, kunCarriedChunkCheck, kunPm2Env } from '../canaryInputs'
import {
  KUN_RELEASE_STATIC_OWN,
  isReleaseId,
  kunReleaseLayoutFor,
  releaseDirOf,
  writeReleaseManifest
} from '../layout'
import { makeTempDir, removeTempDir } from './support/tempDir'
import type { ReleaseId, ReleaseLayout } from '../layout'

const id = (value: string) => {
  if (!isReleaseId(value)) {
    throw new Error(`bad fixture id ${value}`)
  }
  return value
}

let root: string

beforeEach(() => {
  root = makeTempDir('canary-inputs')
})

afterEach(() => {
  removeTempDir(root)
})

describe('kunPm2Env', () => {
  it('drops what the checkout .env put into process.env and every release id', () => {
    const env = kunPm2Env(
      {
        NODE_ENV: 'production',
        PATH: '/usr/bin',
        KUN_DATABASE_URL: 'postgresql://from-dotenv',
        JWT_SECRET: 'exported-in-the-shell',
        KUN_RELEASE_ID: 'stale',
        KUN_RELEASE_SHA: 'stale'
      },
      {
        KUN_DATABASE_URL: 'postgresql://from-dotenv',
        JWT_SECRET: 'from-dotenv',
        KUN_RELEASE_ID: 'stale'
      }
    )

    expect(env).toEqual({
      NODE_ENV: 'production',
      PATH: '/usr/bin',
      // dotenv does not override the shell: a different value was exported on purpose
      JWT_SECRET: 'exported-in-the-shell'
    })
  })
})

describe('kunCanaryEnv', () => {
  const writeEcosystem = (apps: unknown[]) => {
    fs.writeFileSync(
      path.join(root, 'ecosystem.config.cjs'),
      `module.exports = { apps: ${JSON.stringify(apps)} }\n`
    )
  }

  it('takes the env of the app that does not run cron, without its port and cron switch', () => {
    writeEcosystem([
      {
        name: 'cron',
        env: {
          PORT: 3001,
          KUN_ENABLE_CRON: 'true',
          NEXT_MANUAL_SIG_HANDLE: 'true'
        }
      },
      {
        name: 'web',
        env: {
          NODE_ENV: 'production',
          UV_THREADPOOL_SIZE: 8,
          PORT: 3000,
          KUN_ENABLE_CRON: 'false'
        }
      }
    ])

    expect(kunCanaryEnv(root)).toEqual({
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: '8'
    })
  })

  it('refuses an ecosystem without a web app', () => {
    writeEcosystem([{ name: 'cron', env: { KUN_ENABLE_CRON: 'true' } }])
    expect(() => kunCanaryEnv(root)).toThrow('KUN_ENABLE_CRON=false')
  })
})

describe('kunCarriedChunkCheck', () => {
  let layout: ReleaseLayout

  const addRelease = (releaseId: ReleaseId, own: string[]) => {
    const dir = releaseDirOf(layout, releaseId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, KUN_RELEASE_STATIC_OWN),
      own.map((file) => `${file}\n`).join('')
    )
    writeReleaseManifest(dir, {
      id: releaseId,
      gitSha: 'a'.repeat(40),
      builtAt: '2026-11-26T00:00:00.000Z',
      node: 'v26.12.1',
      nextBuildId: 'b',
      distDir: '.next-deploy'
    })
  }

  beforeEach(() => {
    layout = kunReleaseLayoutFor(root)
  })

  it('requests a chunk only the previous release built', () => {
    const previous = id('20261101000000-aaaaaaa')
    const fresh = id('20261102000000-bbbbbbb')
    addRelease(previous, ['chunks/shared.js', 'chunks/old.js', 'css/x.css'])
    addRelease(fresh, ['chunks/shared.js', 'chunks/new.js'])

    expect(kunCarriedChunkCheck(layout, fresh)).toEqual([
      { path: '/_next/static/chunks/old.js', expectStatus: 200 }
    ])
  })

  it('adds nothing on the first release or when no chunk changed', () => {
    const first = id('20261101000000-aaaaaaa')
    addRelease(first, ['chunks/shared.js'])
    expect(kunCarriedChunkCheck(layout, first)).toEqual([])

    const second = id('20261102000000-bbbbbbb')
    addRelease(second, ['chunks/shared.js'])
    expect(kunCarriedChunkCheck(layout, second)).toEqual([])
  })
})
