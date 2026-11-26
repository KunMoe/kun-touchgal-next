import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatVerifyReport,
  isVerifyClean,
  kunReleaseGuardPath,
  kunReleaseRequiredFiles,
  verifyRelease
} from '../verify'
import { makeTempDir, removeTempDir } from './support/tempDir'

const DIST = '.next-deploy'
const NAME = 'fake-0123456789abcdef'
const SCOPED = '@kun/scoped-fedcba9876543210'

let dir: string
let outside: string

const write = (relative: string, content = '') => {
  const file = path.join(dir, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const link = (relative: string, target: string) => {
  const file = path.join(dir, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.symlinkSync(target, file)
}

// 仿 Turbopack: 包本体在 node_modules/.pnpm 下, <distDir>/node_modules/<名字>-<hash> 是指向它的相对软链
const addExternal = (
  hashedName: string,
  files: Record<string, string>,
  type: 'module' | 'commonjs'
) => {
  const store = `node_modules/.pnpm/${hashedName.replace('/', '+')}@1.0.0/node_modules/${hashedName}`
  write(
    `${store}/package.json`,
    JSON.stringify({
      name: hashedName,
      type,
      main: Object.keys(files)[0]
    })
  )
  for (const [file, content] of Object.entries(files)) {
    write(`${store}/${file}`, content)
  }
  const at = `${DIST}/node_modules/${hashedName}`
  link(
    at,
    path.relative(path.dirname(path.join(dir, at)), path.join(dir, store))
  )
}

const chunk = (content: string) =>
  write(`${DIST}/server/chunks/[root-of-the-server]__0abc._.js`, content)

const leftovers = () =>
  [
    ...fs.readdirSync(dir),
    ...fs.readdirSync(path.join(dir, DIST, 'server'))
  ].filter((name) => name.startsWith('.kun-release-'))

beforeEach(() => {
  dir = makeTempDir('verify')
  outside = makeTempDir('verify-outside')
  for (const relative of kunReleaseRequiredFiles(DIST)) {
    if (relative.endsWith('/static') || relative === 'posts') {
      fs.mkdirSync(path.join(dir, relative), { recursive: true })
    } else {
      write(relative, 'x')
    }
  }
  // 与真的 standalone 一样: 根是仓库的 package.json (ESM), <distDir> 下的 chunk 是 CommonJS
  write('package.json', '{"type":"module"}')
  write(`${DIST}/package.json`, '{"type":"commonjs"}')
  chunk('module.exports=[1,(e)=>{e.x("path",()=>require("path"))}]')
})

afterEach(() => {
  removeTempDir(dir)
  removeTempDir(outside)
})

describe('verifyRelease', () => {
  it('passes a complete tree without externals and probes nothing', () => {
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report).toEqual({
      missingFiles: [],
      danglingLinks: [],
      escapingLinks: [],
      externals: [],
      loadFailures: [],
      escapes: []
    })
    expect(isVerifyClean(report)).toBe(true)
    expect(formatVerifyReport(report)).toContain('发布自检通过')
  })

  it('reports missing required files in the listed order', () => {
    fs.rmSync(path.join(dir, 'public/logo.webp'))
    fs.rmSync(path.join(dir, 'posts'), { recursive: true })
    fs.rmSync(path.join(dir, DIST, 'BUILD_ID'))
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report.missingFiles).toEqual([
      `${DIST}/BUILD_ID`,
      'public/logo.webp',
      'posts'
    ])
    expect(isVerifyClean(report)).toBe(false)
    expect(formatVerifyReport(report)).toMatch(
      /^发布自检没有通过: 3 个必需文件缺失/
    )
  })

  it('reports dangling links and links that resolve outside the release', () => {
    write('public/real.txt', 'x')
    link('public/broken', 'does-not-exist')
    link('public/absolute-outside', outside)
    link('public/relative-outside', '../../')
    // 绝对路径但落在发布里面: 按 realpath 判定, 不算逃出
    link('public/absolute-inside', path.join(dir, 'public/real.txt'))
    link('public/relative-inside', 'real.txt')
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report.danglingLinks).toEqual(['public/broken'])
    expect(report.escapingLinks).toEqual([
      { link: 'public/absolute-outside', target: fs.realpathSync(outside) },
      {
        link: 'public/relative-outside',
        target: fs.realpathSync(path.join(dir, '..'))
      }
    ])
    expect(formatVerifyReport(report)).toContain(
      '1 个软链悬空, 2 个软链指向发布之外'
    )
  })

  it('does not walk into symlinked directories', () => {
    fs.mkdirSync(path.join(outside, 'nested'))
    fs.symlinkSync('missing', path.join(outside, 'nested/broken'))
    link('public/outside-dir', outside)
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report.danglingLinks).toEqual([])
    expect(report.escapingLinks.map((entry) => entry.link)).toEqual([
      'public/outside-dir'
    ])
  })

  it('loads the externals the chunks reference, scoped and with subpaths', () => {
    addExternal(NAME, { 'index.mjs': 'export const value = 1\n' }, 'module')
    addExternal(
      SCOPED,
      {
        'index.cjs': 'module.exports = 1\n',
        'runtime/client.cjs': 'module.exports = 2\n'
      },
      'commonjs'
    )
    chunk(
      `var a=await e.y("${NAME}");` +
        `r.exports=e.x("${SCOPED}/runtime/client.cjs",()=>require("${SCOPED}/runtime/client.cjs"))`
    )
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report.externals).toEqual([`${SCOPED}/runtime/client.cjs`, NAME])
    expect(report.loadFailures).toEqual([])
    expect(report.escapes).toEqual([])
    expect(isVerifyClean(report)).toBe(true)
    expect(formatVerifyReport(report)).toContain('探测了 2 个外部包说明符')
    expect(leftovers()).toEqual([])
  })

  it('reports a referenced subpath that does not exist as a load failure', () => {
    addExternal(NAME, { 'index.mjs': 'export const value = 1\n' }, 'module')
    chunk(`var a=await e.y("${NAME}/runtime/missing.mjs")`)
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report.externals).toEqual([`${NAME}/runtime/missing.mjs`])
    expect(report.loadFailures).toHaveLength(1)
    expect(report.loadFailures[0].specifier).toBe(`${NAME}/runtime/missing.mjs`)
    expect(report.loadFailures[0].error).toMatch(/^import: .+; require: .+/)
    expect(report.escapes).toEqual([])
    expect(formatVerifyReport(report)).toContain(
      `外部包加载失败: ${NAME}/runtime/missing.mjs: import:`
    )
    expect(leftovers()).toEqual([])
  })

  // 临时目录在仓库的 node_modules/.cache 下: 发布里没有的 zod 会向上解析进仓库的 node_modules
  it('reports a module that an external resolves from outside the release', () => {
    addExternal(
      NAME,
      { 'index.cjs': "module.exports = require('zod')\n" },
      'commonjs'
    )
    chunk(`e.x("${NAME}",()=>require("${NAME}"))`)
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report.loadFailures).toEqual([])
    expect(report.escapes).toHaveLength(1)
    const [escape] = report.escapes
    expect(escape.specifier).toBe('zod')
    expect(path.relative(fs.realpathSync(dir), escape.resolved)).toMatch(
      /^\.\.\//
    )
    expect(escape.parent).toBe(
      fs.realpathSync(
        path.join(dir, `node_modules/.pnpm/${NAME}@1.0.0/node_modules/${NAME}`)
      ) + '/index.cjs'
    )
    expect(isVerifyClean(report)).toBe(false)
    expect(formatVerifyReport(report)).toContain('模块解析逃出发布: zod → ')
    expect(leftovers()).toEqual([])
  })

  it('blames the external that was loading when the probe died', () => {
    addExternal(
      NAME,
      { 'index.mjs': "console.error('dying'); process.exit(7)\n" },
      'module'
    )
    chunk(`var a=await e.y("${NAME}")`)
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report.loadFailures).toHaveLength(1)
    expect(report.loadFailures[0].specifier).toBe(NAME)
    expect(report.loadFailures[0].error).toContain('退出码 7')
    expect(report.loadFailures[0].error).toContain('dying')
    expect(leftovers()).toEqual([])
  })

  it('does not probe trace paths that only mention an external', () => {
    addExternal(NAME, { 'index.mjs': 'export const value = 1\n' }, 'module')
    chunk(
      `var t="../../node_modules/${NAME}",u="/ROOT/node_modules/${NAME}/x",` +
        `v="${NAME}x",w="${NAME}"`
    )
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report.externals).toEqual([NAME])
    expect(isVerifyClean(report)).toBe(true)
  })
})

describe('guard.mjs', () => {
  const runGuarded = (extra: Record<string, string>) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      ...extra
    }
    return spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(kunReleaseGuardPath).href,
        '-e',
        "try { require('kun-no-such-module') } catch (error) { console.log(error.code) }"
      ],
      {
        cwd: dir,
        env: env as NodeJS.ProcessEnv,
        encoding: 'utf8'
      }
    )
  }

  it('leaves failing resolutions alone and prints nothing of its own', () => {
    const report = path.join(dir, 'guard.jsonl')
    const result = runGuarded({
      KUN_RELEASE_GUARD_ROOT: dir,
      KUN_RELEASE_GUARD_REPORT: report
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('MODULE_NOT_FOUND')
    // 没有 ExperimentalWarning 之类的输出混进金丝雀的日志
    expect(result.stderr).toBe('')
    expect(fs.readFileSync(report, 'utf8')).toBe('')
  })

  it('does nothing when its environment is incomplete', () => {
    const report = path.join(dir, 'guard.jsonl')
    const result = runGuarded({ KUN_RELEASE_GUARD_REPORT: report })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('MODULE_NOT_FOUND')
    expect(fs.existsSync(report)).toBe(false)
  })
})
