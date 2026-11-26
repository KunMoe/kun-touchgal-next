import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatVerifyReport,
  isExpectedKunGuardEscape,
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

  // 临时目录在仓库的 node_modules/.cache 下: 发布里没有的 zod 会向上解析进仓库的 node_modules。
  // 守卫把它拦成找不到, 所以这个外部包同时也加载失败 (与生产上一样)
  it('reports and blocks a module that an external resolves from outside the release', () => {
    addExternal(
      NAME,
      { 'index.cjs': "module.exports = require('zod')\n" },
      'commonjs'
    )
    chunk(`e.x("${NAME}",()=>require("${NAME}"))`)
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report.loadFailures).toHaveLength(1)
    expect(report.loadFailures[0].specifier).toBe(NAME)
    expect(report.loadFailures[0].error).toMatch(
      /^import: MODULE_NOT_FOUND: Cannot find module 'zod' \(发布守卫拦下.*; require: MODULE_NOT_FOUND: /
    )
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

  // 仿 Next 的 loadWebpackHook: next/dist/server/config-utils.js 用 require.resolve 找构建期才用的
  // next/dist/compiled/*, 它们不在发布里, 只在发布之上的仓库 node_modules 里有; 找不到由调用方吞掉
  const addFakeNext = (file: string) => {
    write('node_modules/next/package.json', '{"name":"next"}')
    write(
      `node_modules/next/dist/server/${file}`,
      "try { require.resolve('next/dist/compiled/webpack/webpack-lib') } catch (error) { module.exports = error.code }\n"
    )
    addExternal(
      NAME,
      {
        'index.cjs': `module.exports = require('next/dist/server/${file}')\n`
      },
      'commonjs'
    )
    chunk(`e.x("${NAME}",()=>require("${NAME}"))`)
  }

  it('skips the expected escape of Next loading its webpack hook', () => {
    addFakeNext('config-utils.js')
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report.loadFailures).toEqual([])
    expect(report.escapes).toEqual([])
    expect(isVerifyClean(report)).toBe(true)
  })

  it('reports the same specifier resolved from any other parent', () => {
    addFakeNext('other.js')
    const report = verifyRelease(dir, { distDir: DIST })
    expect(report.loadFailures).toEqual([])
    expect(report.escapes).toHaveLength(1)
    expect(report.escapes[0].specifier).toBe(
      'next/dist/compiled/webpack/webpack-lib'
    )
    expect(report.escapes[0].parent).toMatch(/\/next\/dist\/server\/other\.js$/)
    expect(isVerifyClean(report)).toBe(false)
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

describe('isExpectedKunGuardEscape', () => {
  const parent =
    '/srv/kun-releases/releases/x/node_modules/.pnpm/next@16/node_modules/next/dist/server/config-utils.js'
  it('only allows next/dist/compiled/* resolved from config-utils.js', () => {
    const resolved = '/srv/node_modules/next/dist/compiled/webpack/package.js'
    expect(
      isExpectedKunGuardEscape({
        specifier: 'next/dist/compiled/webpack/package',
        resolved,
        parent
      })
    ).toBe(true)
    expect(
      isExpectedKunGuardEscape({ specifier: 'zod', resolved, parent })
    ).toBe(false)
    expect(
      isExpectedKunGuardEscape({
        specifier: 'next/dist/compiled/webpack/package',
        resolved,
        parent: parent.replace('config-utils.js', 'config.js')
      })
    ).toBe(false)
    expect(
      isExpectedKunGuardEscape({
        specifier: 'next/dist/compiled/webpack/package',
        resolved,
        parent: null
      })
    ).toBe(false)
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

  it('blocks resolutions that leave the root and records each crossing', () => {
    const report = path.join(dir, 'guard.jsonl')
    write(
      'entry.cjs',
      [
        "try { require('zod'); console.log('require loaded') } catch (error) { console.log('require ' + error.code + ' ' + error.message) }",
        "import('zod').then(() => console.log('import loaded'), (error) => console.log('import ' + error.code))"
      ].join('\n')
    )
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(kunReleaseGuardPath).href, 'entry.cjs'],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? '',
          KUN_RELEASE_GUARD_ROOT: dir,
          KUN_RELEASE_GUARD_REPORT: report
        } as Record<string, string> as NodeJS.ProcessEnv,
        encoding: 'utf8'
      }
    )
    expect(result.status).toBe(0)
    const [required, imported] = result.stdout.trim().split('\n')
    expect(required).toMatch(
      /^require MODULE_NOT_FOUND Cannot find module 'zod' \(发布守卫拦下: /
    )
    expect(imported).toBe('import ERR_MODULE_NOT_FOUND')
    const lines = fs
      .readFileSync(report, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const entry = fs.realpathSync(path.join(dir, 'entry.cjs'))
    // require 与 import 解析到 zod 的不同入口, 各记一行
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line.specifier).toBe('zod')
      expect(line.parent).toBe(entry)
      expect(path.relative(fs.realpathSync(dir), line.resolved)).toMatch(
        /^\.\.\//
      )
    }
  })

  it('does nothing when its environment is incomplete', () => {
    const report = path.join(dir, 'guard.jsonl')
    const result = runGuarded({ KUN_RELEASE_GUARD_REPORT: report })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('MODULE_NOT_FOUND')
    expect(fs.existsSync(report)).toBe(false)
  })
})
