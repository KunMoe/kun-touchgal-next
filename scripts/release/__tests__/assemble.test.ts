import fs from 'fs'
import path from 'path'
import { parse } from 'dotenv'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assembleRelease, discardRelease, readStaticOwn } from '../assemble'
import { listStaticFiles } from '../static'
import {
  KUN_RELEASE_MANIFEST,
  KUN_RELEASE_STATIC_OWN,
  kunReleaseLayoutFor,
  listReleases,
  readReleaseManifest,
  releaseDirOf,
  switchCurrentRelease
} from '../layout'
import { makeTempDir, removeTempDir } from './support/tempDir'
import type { ReleaseLayout } from '../layout'

const DIST_DIR = '.next-deploy'
const SHA = 'FC8B626BDEADBEEFDEADBEEFDEADBEEFDEADBEEF'
const ENV_COMMENT =
  '# 以下两行由发布组装 (scripts/release/assemble.ts) 写入, 不要手改'

let root: string
let layout: ReleaseLayout
let builds = 0

const writeFile = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

interface StandaloneFixture {
  buildId?: string | null
  env?: string | null
  distDir?: string
  staticFiles?: Record<string, string>
}

// 检出里一次构建的 standalone, 只放组装会碰到的文件
const makeStandalone = ({
  buildId = 'build-id',
  env = 'DATABASE_URL=postgres://localhost/kun\n',
  distDir = DIST_DIR,
  staticFiles = {}
}: StandaloneFixture = {}) => {
  builds += 1
  const dir = path.join(root, 'checkout', `build-${builds}`, 'standalone')
  writeFile(path.join(dir, 'server.js'), '// server')
  if (env !== null) {
    writeFile(path.join(dir, '.env'), env)
  }
  if (buildId !== null) {
    writeFile(path.join(dir, distDir, 'BUILD_ID'), `${buildId}\n`)
  }
  for (const [file, content] of Object.entries(staticFiles)) {
    writeFile(path.join(dir, distDir, 'static', file), content)
  }
  return dir
}

const assemble = (
  standaloneDir: string,
  {
    at = '2026-11-26T00:00:00.000Z',
    gitSha = SHA,
    distDir = DIST_DIR
  }: { at?: string; gitSha?: string; distDir?: string } = {}
) =>
  assembleRelease({
    layout,
    standaloneDir,
    distDir,
    gitSha,
    now: new Date(at),
    node: 'v26.12.1'
  })

const staticOf = (releaseDir: string, file: string, distDir = DIST_DIR) =>
  path.join(releaseDir, distDir, 'static', file)

beforeEach(() => {
  root = makeTempDir('assemble')
  layout = kunReleaseLayoutFor(path.join(root, 'kun-releases'))
})

afterEach(() => {
  vi.restoreAllMocks()
  removeTempDir(root)
})

describe('assembleRelease', () => {
  it('moves the standalone in and records it as a release', () => {
    const standalone = makeStandalone({
      buildId: '  abc123 ',
      staticFiles: { 'chunks/a.js': 'a', 'abc123/_buildManifest.js': 'm' }
    })

    const manifest = assemble(standalone, { at: '2026-11-26T03:04:05.678Z' })

    expect(manifest).toEqual({
      id: '20261126030405-fc8b626',
      gitSha: SHA.toLowerCase(),
      builtAt: '2026-11-26T03:04:05.678Z',
      node: 'v26.12.1',
      nextBuildId: 'abc123',
      distDir: DIST_DIR
    })
    const dir = releaseDirOf(layout, manifest.id)
    expect(fs.existsSync(standalone)).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'server.js'), 'utf8')).toBe(
      '// server'
    )
    expect(readReleaseManifest(dir)).toEqual(manifest)
    expect(listReleases(layout)).toEqual([manifest])
    expect(
      fs.readFileSync(path.join(dir, KUN_RELEASE_STATIC_OWN), 'utf8')
    ).toBe('abc123/_buildManifest.js\nchunks/a.js\n')
  })

  it('writes the manifest after everything else', () => {
    const older = assemble(
      makeStandalone({ staticFiles: { 'chunks/old.js': 'old' } }),
      { at: '2026-11-25T00:00:00Z' }
    )
    expect(older.id).toBe('20261125000000-fc8b626')
    const standalone = makeStandalone({
      staticFiles: { 'chunks/new.js': 'new' }
    })
    const writes: string[] = []
    // appendFileSync 内部经由 fs.writeFileSync 写 (实测 Node 26), 连续的同一个文件只记一次
    const record = (target: fs.PathOrFileDescriptor | fs.PathLike) => {
      const name = path.basename(String(target))
      if (writes.at(-1) !== name) {
        writes.push(name)
      }
    }
    const { writeFileSync, appendFileSync, linkSync } = fs
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
      record(file)
      writeFileSync(file, ...rest)
    })
    vi.spyOn(fs, 'appendFileSync').mockImplementation((file, ...rest) => {
      record(file)
      appendFileSync(file, ...rest)
    })
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      record(to)
      linkSync(from, to)
    })

    assemble(standalone)

    expect(writes).toEqual([
      KUN_RELEASE_STATIC_OWN,
      '.env',
      'old.js',
      KUN_RELEASE_MANIFEST
    ])
  })

  it.each([
    ['ends with a newline', 'A=1\n', 'A=1\n'],
    ['does not end with a newline', 'A=1', 'A=1\n'],
    ['is empty', '', ''],
    ['is missing', null, '']
  ])('appends the release env lines when the .env %s', (_case, env, kept) => {
    const manifest = assemble(makeStandalone({ env }))
    const content = fs.readFileSync(
      path.join(releaseDirOf(layout, manifest.id), '.env'),
      'utf8'
    )
    expect(content).toBe(
      `${kept}${ENV_COMMENT}\nKUN_RELEASE_ID=${manifest.id}\nKUN_RELEASE_SHA=${SHA.toLowerCase()}\n`
    )
  })

  it('overrides a stale release id copied in from the checkout .env', () => {
    const manifest = assemble(
      makeStandalone({
        env: 'KUN_RELEASE_ID=stale\nKUN_RELEASE_SHA=stale\nDATABASE_URL=x'
      })
    )
    const parsed = parse(
      fs.readFileSync(
        path.join(releaseDirOf(layout, manifest.id), '.env'),
        'utf8'
      )
    )
    expect(parsed).toEqual({
      KUN_RELEASE_ID: manifest.id,
      KUN_RELEASE_SHA: SHA.toLowerCase(),
      DATABASE_URL: 'x'
    })
  })

  it('carries the older releases’ own static files forward without overwriting', () => {
    const first = assemble(
      makeStandalone({
        staticFiles: { 'chunks/a.js': 'a', 'chunks/shared.js': 'first' }
      }),
      { at: '2026-11-24T00:00:00Z' }
    )
    const second = assemble(
      makeStandalone({
        staticFiles: { 'chunks/b.js': 'b', 'chunks/shared.js': 'second' }
      }),
      { at: '2026-11-25T00:00:00Z' }
    )
    const third = assemble(
      makeStandalone({ staticFiles: { 'chunks/c.js': 'c' } }),
      { at: '2026-11-26T00:00:00Z' }
    )
    const firstDir = releaseDirOf(layout, first.id)
    const secondDir = releaseDirOf(layout, second.id)
    const thirdDir = releaseDirOf(layout, third.id)
    const ino = (file: string) => fs.statSync(file).ino

    // 第二次构建自己的 shared.js 优先于带过来的
    expect(
      fs.readFileSync(staticOf(secondDir, 'chunks/shared.js'), 'utf8')
    ).toBe('second')
    expect(ino(staticOf(secondDir, 'chunks/a.js'))).toBe(
      ino(staticOf(firstDir, 'chunks/a.js'))
    )
    // 自己的清单里没有带过来的文件
    expect(readStaticOwn(secondDir)).toEqual([
      'chunks/b.js',
      'chunks/shared.js'
    ])
    expect(readStaticOwn(thirdDir)).toEqual(['chunks/c.js'])

    // 第三个发布从每个更早的发布带它们自己的文件, 同名时较新的来源优先
    expect(listStaticFiles(path.join(thirdDir, DIST_DIR, 'static'))).toEqual([
      'chunks/a.js',
      'chunks/b.js',
      'chunks/c.js',
      'chunks/shared.js'
    ])
    expect(ino(staticOf(thirdDir, 'chunks/a.js'))).toBe(
      ino(staticOf(firstDir, 'chunks/a.js'))
    )
    expect(ino(staticOf(thirdDir, 'chunks/b.js'))).toBe(
      ino(staticOf(secondDir, 'chunks/b.js'))
    )
    expect(ino(staticOf(thirdDir, 'chunks/shared.js'))).toBe(
      ino(staticOf(secondDir, 'chunks/shared.js'))
    )
    expect(fs.statSync(staticOf(firstDir, 'chunks/a.js')).nlink).toBe(3)
  })

  it('finds an older release’s static files under its own distDir', () => {
    const older = assemble(
      makeStandalone({ distDir: '.next', staticFiles: { 'chunks/a.js': 'a' } }),
      { at: '2026-11-25T00:00:00Z', distDir: '.next' }
    )
    const newer = assemble(
      makeStandalone({ staticFiles: { 'chunks/b.js': 'b' } })
    )
    expect(
      fs.statSync(staticOf(releaseDirOf(layout, newer.id), 'chunks/a.js')).ino
    ).toBe(
      fs.statSync(
        staticOf(releaseDirOf(layout, older.id), 'chunks/a.js', '.next')
      ).ino
    )
  })

  it('refuses an id that already exists and leaves both trees alone', () => {
    const standalone = makeStandalone()
    const existing = path.join(layout.releasesDir, '20261126000000-fc8b626')
    writeFile(path.join(existing, 'marker'), 'keep')

    expect(() => assemble(standalone)).toThrow('已经存在')
    expect(fs.existsSync(path.join(standalone, 'server.js'))).toBe(true)
    expect(fs.readdirSync(existing)).toEqual(['marker'])
  })

  it('names both paths when the release root is on another filesystem', () => {
    const standalone = makeStandalone()
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {
        code: 'EXDEV'
      })
    })

    let message = ''
    try {
      assemble(standalone)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('不在同一个文件系统上')
    expect(message).toContain(standalone)
    expect(message).toContain(
      path.join(layout.releasesDir, '20261126000000-fc8b626')
    )
    expect(fs.existsSync(path.join(standalone, 'server.js'))).toBe(true)
  })

  it('removes the half-assembled dir when a step after the move fails', () => {
    expect(() => assemble(makeStandalone({ buildId: null }))).toThrow()
    expect(fs.readdirSync(layout.releasesDir)).toEqual([])
  })
})

describe('readStaticOwn', () => {
  it('is empty for a release without the list', () => {
    expect(readStaticOwn(path.join(root, 'nowhere'))).toEqual([])
  })
})

describe('discardRelease', () => {
  it('removes a release that is not live and refuses the live one', () => {
    const live = assemble(makeStandalone(), { at: '2026-11-25T00:00:00Z' })
    const failed = assemble(makeStandalone())
    switchCurrentRelease(layout, live.id)

    expect(() => discardRelease(layout, live.id)).toThrow()
    discardRelease(layout, failed.id)
    expect(listReleases(layout).map((manifest) => manifest.id)).toEqual([
      live.id
    ])
    expect(fs.existsSync(releaseDirOf(layout, failed.id))).toBe(false)
  })
})
