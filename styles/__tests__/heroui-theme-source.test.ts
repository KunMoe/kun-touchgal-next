import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// C39: tailwind.css 只扫描 HeroUI 用到的组件主题文件, 未用组件用 @source not
// 排除, 以缩小全站阻塞渲染的 CSS。排除表一旦包含实际在用的组件, 该组件会没有
// 样式, 而构建和类型检查都不会报错。所以这里从源码的 @heroui/* 导入出发, 沿包的
// dependencies 做传递闭包 (Select 会带上 listbox/popover, Table 会带上 checkbox/
// spacer), 收集它们从 @heroui/theme 取用的 slot, 断言都没有被排除
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const COMPONENTS_SOURCE = '../node_modules/@heroui/theme/dist/components'
const themeComponentsDir = join(
  repoRoot,
  'node_modules/@heroui/theme/dist/components'
)

const read = (file: string) => readFileSync(file, 'utf-8')

// 跳过隐藏目录 (.next、.claude 下有整仓副本)、依赖和被 gitignore 的 docs
const listSourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      return []
    }
    if (entry.isDirectory()) {
      return path === join(repoRoot, 'docs') || entry.name === '__tests__'
        ? []
        : listSourceFiles(path)
    }
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })

const NAMED_IMPORT =
  /^[ \t]*(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*['"](@heroui\/[\w-]+)['"]/gm
const ANY_IMPORT = /(?:\bfrom|\bimport\s*\(?)\s*['"](@heroui\/[\w-]+)['"]/g
// 默认导入、命名空间导入、动态导入 @heroui/react 时无法静态得知用到哪些组件
const OPAQUE_REACT_IMPORT =
  /(?:\bimport\s+(?:\*\s*as\s+)?\w+\s+from|\bimport\s*\()\s*['"]@heroui\/react['"]/

const valueNames = (clause: string) =>
  clause
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name && !name.startsWith('type '))
    .map((name) => name.split(/\s+as\s+/)[0].trim())

const exportedNames = (source: string) =>
  new Set(
    [...source.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((match) =>
      match[1]
        .split(',')
        .map((name) =>
          name
            .trim()
            .split(/\s+as\s+/)
            .pop()!
        )
        .filter(Boolean)
    )
  )

// pnpm 下同名包按 peer 组合会有多份, 按引用方目录逐级查 node_modules
const packageDir = (name: string, fromDir: string) => {
  const lookup = createRequire(join(fromDir, 'package.json')).resolve.paths(
    name
  )
  for (const base of lookup ?? []) {
    if (existsSync(join(base, name, 'package.json'))) {
      return realpathSync(join(base, name))
    }
  }
  throw new Error(`无法从 ${fromDir} 解析 ${name}`)
}

const distFiles = (dir: string) =>
  readdirSync(join(dir, 'dist'), { recursive: true, encoding: 'utf-8' })
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => join(dir, 'dist', file))

const collectUsage = () => {
  const reactDir = packageDir('@heroui/react', repoRoot)
  const reactExportOwner = new Map<string, string>()
  const reactIndex = read(join(reactDir, 'dist/index.mjs'))
  for (const [, pkg] of reactIndex.matchAll(
    /export\s*\*\s*from\s*"(@heroui\/[\w-]+)"/g
  )) {
    const index = read(join(packageDir(pkg, reactDir), 'dist/index.mjs'))
    for (const name of exportedNames(index)) {
      if (!reactExportOwner.has(name)) {
        reactExportOwner.set(name, pkg)
      }
    }
  }

  const themeNames = new Set<string>()
  const queue: [string, string][] = []
  const unmapped: string[] = []
  const opaque: string[] = []
  const enqueue = (pkg: string, fromDir: string) => {
    if (pkg !== '@heroui/theme') {
      queue.push([pkg, fromDir])
    }
  }

  for (const file of listSourceFiles(repoRoot)) {
    const source = read(file)
    if (OPAQUE_REACT_IMPORT.test(source)) {
      opaque.push(file)
    }
    for (const [, typeOnly, clause, pkg] of source.matchAll(NAMED_IMPORT)) {
      if (typeOnly || (pkg !== '@heroui/react' && pkg !== '@heroui/theme')) {
        continue
      }
      for (const name of valueNames(clause)) {
        const owner = pkg === '@heroui/react' ? reactExportOwner.get(name) : pkg
        if (!owner) {
          unmapped.push(`${name} (${file})`)
        } else if (owner === '@heroui/theme') {
          themeNames.add(name)
        } else {
          enqueue(owner, reactDir)
        }
      }
    }
    for (const [, pkg] of source.matchAll(ANY_IMPORT)) {
      if (pkg !== '@heroui/react' && pkg !== '@heroui/theme') {
        enqueue(pkg, repoRoot)
      }
    }
  }

  const visited = new Set<string>()
  while (queue.length) {
    const [pkg, fromDir] = queue.shift()!
    const dir = packageDir(pkg, fromDir)
    if (visited.has(dir)) {
      continue
    }
    visited.add(dir)
    const { dependencies = {} } = JSON.parse(read(join(dir, 'package.json')))
    for (const dep of Object.keys(dependencies)) {
      if (dep.startsWith('@heroui/')) {
        enqueue(dep, dir)
      }
    }
    for (const file of distFiles(dir)) {
      for (const [, clause] of read(file).matchAll(
        /import\s*\{([^}]*)\}\s*from\s*"@heroui\/theme"/g
      )) {
        valueNames(clause).forEach((name) => themeNames.add(name))
      }
    }
  }

  return { themeNames, unmapped, opaque, packageCount: visited.size }
}

// slot 名 → 组件主题文件名 (如 avatarGroup → avatar, circularProgress → progress);
// tv / mergeClasses 这类工具函数不属于任何组件, 查不到即忽略
const themeComponentOf = new Map<string, string>()
for (const file of readdirSync(themeComponentsDir)) {
  if (file.endsWith('.mjs') && file !== 'index.mjs') {
    for (const name of exportedNames(read(join(themeComponentsDir, file)))) {
      themeComponentOf.set(name, file.slice(0, -'.mjs'.length))
    }
  }
}

const sources = [
  ...read(join(repoRoot, 'styles/tailwind.css')).matchAll(
    /^@source\s+(not\s+)?'([^']+)';/gm
  )
].map(([, negated, path]) => ({ negated: Boolean(negated), path }))

const excludedComponents = sources
  .filter(({ negated }) => negated)
  .flatMap(({ path }) => {
    const match = path.match(/\/components\/\{([^}]+)\}\.js$/)
    return match ? match[1].split(',') : []
  })

describe('tailwind.css 只扫描实际用到的 HeroUI 组件主题', () => {
  const usage = collectUsage()
  const usedComponents = [...usage.themeNames]
    .map((name) => themeComponentOf.get(name))
    .filter((component): component is string => Boolean(component))

  it('正向只扫组件主题文件, 并排除全量打包的 index.js', () => {
    expect(sources.filter(({ negated }) => !negated)).toEqual([
      { negated: false, path: `${COMPONENTS_SOURCE}/*.js` }
    ])
    expect(sources).toContainEqual({
      negated: true,
      path: `${COMPONENTS_SOURCE}/index.js`
    })
    expect(excludedComponents.length).toBeGreaterThan(0)
  })

  it('排除表里的组件主题文件都存在', () => {
    const missing = excludedComponents.filter(
      (component) => !existsSync(join(themeComponentsDir, `${component}.js`))
    )
    expect(missing).toEqual([])
  })

  it('源码里的 HeroUI 导入都能静态解析', () => {
    expect(usage.opaque).toEqual([])
    expect(usage.unmapped).toEqual([])
    // 闭包确实走到了内部依赖: 源码没有直接导入 Menu, 它只经 Dropdown 引入
    expect(usedComponents).toEqual(expect.arrayContaining(['button', 'menu']))
  })

  it('用到的组件 (含 HeroUI 内部依赖) 都没有被排除', () => {
    const wronglyExcluded = [...new Set(usedComponents)].filter((component) =>
      excludedComponents.includes(component)
    )
    // 红了就把这些组件从 styles/tailwind.css 的 @source not 排除表中删掉
    expect(wronglyExcluded).toEqual([])
  })
})
