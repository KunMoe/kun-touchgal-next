// 发布的自检: 必需文件、软链、Turbopack 的外部包。postbuild 在每次 pnpm build 之后对 standalone 跑一遍
// (本地、CI 与生产构建都会走到), 部署链因此在停掉任何线上进程之前就挡下残缺的构建。
//
// 在线进程跑在检出之外的发布目录里: standalone 缺的东西上线后直接崩, 不会再被检出的 node_modules
// 悄悄补上。外部包 (<distDir>/node_modules/<包>-<hash>, chunk 按这个名字 import / require) 要真的加载
// 一遍才知道齐不齐: 探测脚本放在 <distDir>/server/ 下, 裸说明符的解析与 chunk 一样; 带着 guard.mjs 跑,
// 解析落到发布目录之外的每一次都记下来。在检出里构建时, 向上就是检出的 node_modules, 缺失正好暴露成逃逸。
//
// 除了探测脚本与守卫报告这两个用完即删的临时文件, 不写任何东西; 探测只加载模块, 不连库、不读 .env
import { spawnSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

export const kunReleaseGuardPath = fileURLToPath(
  new URL('./guard.mjs', import.meta.url)
)

// 相对 standalone / 发布根。后五项是 postbuild 复制进 standalone 的运行期文件
export const kunReleaseRequiredFiles = (distDir: string): string[] => [
  'server.js',
  '.env',
  'package.json',
  `${distDir}/BUILD_ID`,
  `${distDir}/static`,
  'public/logo.webp',
  'public/sooner/こじかひわ.webp',
  'public/cap/cap_wasm_bg.wasm',
  'posts',
  'config/redirect.json'
]

export interface KunGuardEscape {
  specifier: string
  resolved: string
  parent: string | null
}

export interface VerifyReport {
  missingFiles: string[]
  danglingLinks: string[]
  escapingLinks: { link: string; target: string }[]
  externals: string[]
  loadFailures: { specifier: string; error: string }[]
  escapes: KunGuardEscape[]
}

export interface VerifyOptions {
  distDir: string
}

// 一个外部包加载卡住 (顶层 await 不返回) 时由它兜底, 线上进程同样会卡在那里
const PROBE_TIMEOUT_MS = 60_000
const PROBE_RESULT_MARKER = 'KUN_RELEASE_PROBE_RESULT '
const PROBE_PROGRESS_MARKER = 'KUN_RELEASE_PROBE '

// 探测脚本。chunk 里 e.y(...) 是 import, e.x(..., () => require(...)) 是 require, 这里先 import 再
// require 兜底。进度写 stderr: 进程异常结束时最后一行就是正在加载的那个。结果写完即退出,
// 不等被加载的模块留下的句柄
const PROBE_SOURCE = String.raw`import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const specifiers = JSON.parse(process.argv[2])
const describe = (error) => {
  if (error instanceof Error) {
    const code = typeof error.code === 'string' ? error.code + ': ' : ''
    return code + String(error.message).split('\n')[0]
  }
  return String(error)
}
const failures = []
for (const specifier of specifiers) {
  process.stderr.write('${PROBE_PROGRESS_MARKER}' + specifier + '\n')
  try {
    await import(specifier)
  } catch (importError) {
    try {
      require(specifier)
    } catch (requireError) {
      failures.push({
        specifier,
        error: 'import: ' + describe(importError) + '; require: ' + describe(requireError)
      })
    }
  }
}
process.stdout.write('${PROBE_RESULT_MARKER}' + JSON.stringify({ failures }) + '\n', () =>
  process.exit(0)
)
`

const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

// 不跟随软链的深度遍历; 软链指向的目录若在发布里面, 本来就会被遍历到
const walk = (
  dir: string,
  visit: (relative: string, entry: fs.Dirent) => void
) => {
  const pending = ['']
  while (pending.length > 0) {
    const current = pending.pop() as string
    for (const entry of fs.readdirSync(path.join(dir, current), {
      withFileTypes: true
    })) {
      const relative = current ? path.join(current, entry.name) : entry.name
      visit(relative, entry)
      if (entry.isDirectory()) {
        pending.push(relative)
      }
    }
  }
}

const findMissingFiles = (dir: string, distDir: string) =>
  kunReleaseRequiredFiles(distDir).filter((relative) => {
    try {
      fs.statSync(path.join(dir, relative))
      return false
    } catch {
      return true
    }
  })

const checkLinks = (dir: string, realDir: string) => {
  const danglingLinks: string[] = []
  const escapingLinks: { link: string; target: string }[] = []
  walk(dir, (relative, entry) => {
    if (!entry.isSymbolicLink()) {
      return
    }
    let target: string
    try {
      target = fs.realpathSync(path.join(dir, relative))
    } catch {
      danglingLinks.push(relative)
      return
    }
    if (!isInside(realDir, target)) {
      escapingLinks.push({ link: relative, target })
    }
  })
  danglingLinks.sort()
  escapingLinks.sort((a, b) => (a.link < b.link ? -1 : a.link > b.link ? 1 : 0))
  return { danglingLinks, escapingLinks }
}

const readDirNames = (dir: string) => {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith('.'))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

// <distDir>/node_modules 下的一层, 作用域包展开一层: @aws-sdk/client-s3-<hash>
const listExternalNames = (externalsDir: string) =>
  readDirNames(externalsDir).flatMap((name) =>
    name.startsWith('@')
      ? readDirNames(path.join(externalsDir, name)).map(
          (inner) => `${name}/${inner}`
        )
      : [name]
  )

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// chunk 里引用外部包的字符串字面量: 以包名开头, 可带子路径 ("@prisma/client-<hash>/runtime/client")。
// 字面量必须从包名开始: chunk 里还有 "../../node_modules/<包名>" 这样的追踪路径, 它们不是加载点
const collectSpecifiers = (serverDir: string, names: string[]) => {
  if (names.length === 0 || !fs.existsSync(serverDir)) {
    return []
  }
  const alternatives = names.map(escapeRegExp).join('|')
  const pattern = new RegExp(
    String.raw`(["'])((?:${alternatives})(?:/[^"'\\\s]+)?)\1`,
    'g'
  )
  const specifiers = new Set<string>()
  walk(serverDir, (relative, entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      return
    }
    const source = fs.readFileSync(path.join(serverDir, relative), 'utf8')
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[2])
    }
  })
  return [...specifiers].sort()
}

// 守卫的报告: 文件不存在 (null) 说明守卫没有生效, 此时「没有逃逸」不可信
export const readKunGuardReport = (file: string): KunGuardEscape[] | null => {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  const escapes: KunGuardEscape[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.trim() || seen.has(line)) {
      continue
    }
    seen.add(line)
    try {
      const parsed = JSON.parse(line) as Partial<KunGuardEscape>
      escapes.push({
        specifier: String(parsed.specifier),
        resolved: String(parsed.resolved),
        parent: typeof parsed.parent === 'string' ? parsed.parent : null
      })
    } catch {
      // 进程被杀时可能留下写了一半的最后一行, 前面的行照常算
    }
  }
  return escapes
}

// 一行一个 (说明符, 落点): 同一个缺失的包常被几处同时引用, 发起方只列第一处与总数
export const formatKunGuardEscapes = (escapes: readonly KunGuardEscape[]) => {
  const groups = new Map<string, { parents: (string | null)[] }>()
  for (const escape of escapes) {
    const key = `${escape.specifier} → ${escape.resolved}`
    const group = groups.get(key) ?? { parents: [] }
    group.parents.push(escape.parent)
    groups.set(key, group)
  }
  return [...groups].map(([key, { parents }]) => {
    const first = parents.find((parent) => parent !== null)
    const more = parents.length > 1 ? ` 等 ${parents.length} 处` : ''
    return first ? `${key} (来自 ${first}${more})` : key
  })
}

const tailOf = (text: string, lines: number) =>
  text.trimEnd().split('\n').slice(-lines).join('\n')

const probeExternals = (dir: string, distDir: string, specifiers: string[]) => {
  const suffix = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const probe = path.join(
    dir,
    distDir,
    'server',
    `.kun-release-probe-${suffix}.mjs`
  )
  const report = path.join(dir, `.kun-release-guard-${suffix}.jsonl`)
  try {
    fs.writeFileSync(probe, PROBE_SOURCE)
    const env: Record<string, string> = {
      KUN_RELEASE_GUARD_ROOT: dir,
      KUN_RELEASE_GUARD_REPORT: report
    }
    for (const key of ['PATH', 'HOME']) {
      const value = process.env[key]
      if (value !== undefined) {
        env[key] = value
      }
    }
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(kunReleaseGuardPath).href,
        probe,
        JSON.stringify(specifiers)
      ],
      {
        cwd: dir,
        // 不含 NODE_ENV: 探测只加载模块, 与它无关
        env: env as NodeJS.ProcessEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024
      }
    )
    // 进程根本没起来 (没有 pid) 是环境问题; 起来之后的超时、输出超限等算这次探测的结果
    if (result.error && !result.pid) {
      throw new Error(`外部包探测进程没有跑起来: ${result.error.message}`)
    }
    const timedOut =
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'

    const escapes = readKunGuardReport(report)
    if (escapes === null) {
      throw new Error(
        `模块解析守卫 (${kunReleaseGuardPath}) 没有生效: 探测之后没有报告文件。` +
          `当前 Node ${process.version} 需要支持 module.registerHooks`
      )
    }

    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const resultLine = stdout
      .split('\n')
      .find((line) => line.startsWith(PROBE_RESULT_MARKER))
    if (resultLine !== undefined) {
      const parsed = JSON.parse(
        resultLine.slice(PROBE_RESULT_MARKER.length)
      ) as {
        failures: { specifier: string; error: string }[]
      }
      return { loadFailures: parsed.failures, escapes }
    }
    // 没有结果: 加载某个外部包时进程崩了或卡住了, 算在 stderr 里最后开始加载的那个头上
    const lastProbed = stderr
      .split('\n')
      .filter((line) => line.startsWith(PROBE_PROGRESS_MARKER))
      .pop()
      ?.slice(PROBE_PROGRESS_MARKER.length)
    const how = timedOut
      ? `${PROBE_TIMEOUT_MS / 1000} 秒内没有结束`
      : result.error
        ? `异常结束 (${result.error.message})`
        : `异常结束 (退出码 ${result.status}, 信号 ${result.signal})`
    return {
      loadFailures: [
        {
          specifier: lastProbed ?? '(探测进程)',
          error: `探测进程加载它时${how}; stderr 末尾: ${tailOf(stderr, 5)}`
        }
      ],
      escapes
    }
  } finally {
    fs.rmSync(probe, { force: true })
    fs.rmSync(report, { force: true })
  }
}

export const verifyRelease = (
  dir: string,
  { distDir }: VerifyOptions
): VerifyReport => {
  const root = path.resolve(dir)
  const realRoot = fs.realpathSync(root)
  const missingFiles = findMissingFiles(root, distDir)
  const { danglingLinks, escapingLinks } = checkLinks(root, realRoot)
  const names = listExternalNames(path.join(root, distDir, 'node_modules'))
  const externals = collectSpecifiers(path.join(root, distDir, 'server'), names)
  const { loadFailures, escapes } =
    externals.length > 0
      ? probeExternals(root, distDir, externals)
      : { loadFailures: [], escapes: [] }
  return {
    missingFiles,
    danglingLinks,
    escapingLinks,
    externals,
    loadFailures,
    escapes
  }
}

export const isVerifyClean = (report: VerifyReport) =>
  report.missingFiles.length === 0 &&
  report.danglingLinks.length === 0 &&
  report.escapingLinks.length === 0 &&
  report.loadFailures.length === 0 &&
  report.escapes.length === 0

export const formatVerifyReport = (report: VerifyReport) => {
  if (isVerifyClean(report)) {
    return `发布自检通过: 必需文件齐全, 软链都在发布里面, 探测了 ${report.externals.length} 个外部包说明符, 没有加载失败与解析逃逸`
  }
  const counts = [
    [report.missingFiles.length, '个必需文件缺失'],
    [report.danglingLinks.length, '个软链悬空'],
    [report.escapingLinks.length, '个软链指向发布之外'],
    [report.loadFailures.length, '个外部包说明符加载失败'],
    [report.escapes.length, '处模块解析逃出发布']
  ] as const
  const lines = [
    `发布自检没有通过: ${counts
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${count} ${label}`)
      .join(', ')} (探测了 ${report.externals.length} 个外部包说明符)`,
    ...report.missingFiles.map((file) => `缺少必需文件: ${file}`),
    ...report.danglingLinks.map((link) => `软链悬空: ${link}`),
    ...report.escapingLinks.map(
      ({ link, target }) => `软链指向发布之外: ${link} → ${target}`
    ),
    ...report.loadFailures.map(
      ({ specifier, error }) => `外部包加载失败: ${specifier}: ${error}`
    ),
    ...formatKunGuardEscapes(report.escapes).map(
      (line) => `模块解析逃出发布: ${line}`
    )
  ]
  return lines.join('\n')
}
