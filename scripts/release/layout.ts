// 发布根里的目录与清单: releases/<id>/ 是一次构建的 standalone 整体移进来的发布, current 是指向
// 在线那一个的相对软链。切换 current 只能在所有进程都停下之后做: PM2 的 cwd 记的是软链路径,
// 单个 worker 重启 (max_memory_restart) 会按 current 当时的指向起来, 进程在跑时切换就是新旧混跑
import fs from 'fs'
import path from 'path'
import { kunReleaseLayout, kunReleaseLayoutAt } from './layout.cjs'

export type ReleaseId = string & { readonly __brand: 'ReleaseId' }

export interface ReleaseLayout {
  root: string
  releasesDir: string
  currentLink: string
}

export interface ReleaseManifest {
  id: ReleaseId
  gitSha: string
  builtAt: string
  // 构建时的 process.version
  node: string
  nextBuildId: string
  // 构建时的 KUN_NEXT_DIST_DIR: 发布里的服务端与静态资源在 <发布>/<distDir>/ 下
  distDir: string
}

export const KUN_RELEASE_MANIFEST = 'release.json'
// 这个发布自己构建出的静态资源 (相对 <distDir>/static 的路径, 一行一个)。之后的发布按它从这里
// 硬链接旧的 chunk, 不按目录里实际有的文件: 目录里还有它自己带过来的更早的文件, 按目录带会越积越多
export const KUN_RELEASE_STATIC_OWN = 'static-own.txt'
// 保留的发布个数 (含在线的那一个)。更早的发布连同它们独有的静态资源一起删掉
export const KUN_RELEASES_KEEP = 3

const RELEASE_ID_PATTERN = /^\d{14}-[0-9a-f]{7}$/

export const kunRepoReleaseLayout = (repoDir: string): ReleaseLayout =>
  kunReleaseLayout(repoDir)

export const kunReleaseLayoutFor = (root: string): ReleaseLayout =>
  kunReleaseLayoutAt(root)

export const isReleaseId = (value: string): value is ReleaseId =>
  RELEASE_ID_PATTERN.test(value)

const pad = (value: number) => String(value).padStart(2, '0')

// UTC 时刻到秒 + 提交的前 7 位: 按字符串排序就是按构建先后, 同一提交一分钟内重跑也不撞名
export const makeReleaseId = (now: Date, gitSha: string): ReleaseId => {
  const sha = gitSha.trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`认不出的提交号: ${gitSha}`)
  }
  const stamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds())
  ].join('')
  const id = `${stamp}-${sha.slice(0, 7)}`
  if (!isReleaseId(id)) {
    throw new Error(`生成的发布 id 不合法: ${id}`)
  }
  return id
}

export const releaseDirOf = (layout: ReleaseLayout, id: ReleaseId) =>
  path.join(layout.releasesDir, id)

export const readReleaseManifest = (dir: string): ReleaseManifest | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(dir, KUN_RELEASE_MANIFEST), 'utf8')
    )
  } catch {
    return null
  }
  const manifest = parsed as Partial<ReleaseManifest> | null
  if (
    !manifest ||
    typeof manifest.id !== 'string' ||
    !isReleaseId(manifest.id) ||
    manifest.id !== path.basename(dir) ||
    typeof manifest.gitSha !== 'string' ||
    typeof manifest.builtAt !== 'string' ||
    typeof manifest.node !== 'string' ||
    typeof manifest.nextBuildId !== 'string' ||
    typeof manifest.distDir !== 'string'
  ) {
    return null
  }
  return manifest as ReleaseManifest
}

export const writeReleaseManifest = (
  dir: string,
  manifest: ReleaseManifest
) => {
  fs.writeFileSync(
    path.join(dir, KUN_RELEASE_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

// 新的在前。名字不像发布 id、或者没有完整清单的目录 (移进来之后没写完清单就中断的) 不算发布
export const listReleases = (layout: ReleaseLayout): ReleaseManifest[] => {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(layout.releasesDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  return entries
    .filter((entry) => entry.isDirectory() && isReleaseId(entry.name))
    .map((entry) =>
      readReleaseManifest(path.join(layout.releasesDir, entry.name))
    )
    .filter((manifest): manifest is ReleaseManifest => manifest !== null)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

// current 不存在时是 null: 还没切到发布布局, 在线的是检出里的旧构建 (ecosystem.config.cjs 据此回退)
export const readCurrentReleaseId = (
  layout: ReleaseLayout
): ReleaseId | null => {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(layout.currentLink)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(`${layout.currentLink} 不是软链, 不知道在线的是哪个发布`)
  }
  const target = fs.readlinkSync(layout.currentLink)
  const id = path.basename(target)
  if (
    !isReleaseId(id) ||
    path.resolve(path.dirname(layout.currentLink), target) !==
      releaseDirOf(layout, id)
  ) {
    throw new Error(
      `${layout.currentLink} 指向 ${target}, 不是 ${layout.releasesDir} 下的发布`
    )
  }
  return id
}

// 原子地把 current 换成 releases/<id> (先建临时软链再 rename 覆盖); null 是删掉 current, 回到旧布局。
// 只能在所有进程都停下之后调用, 原因见文件头
export const switchCurrentRelease = (
  layout: ReleaseLayout,
  id: ReleaseId | null
) => {
  if (id === null) {
    fs.rmSync(layout.currentLink, { force: true })
    return
  }
  const dir = releaseDirOf(layout, id)
  if (!fs.statSync(dir).isDirectory()) {
    throw new Error(`${dir} 不是目录`)
  }
  const temporary = `${layout.currentLink}.tmp`
  fs.rmSync(temporary, { force: true })
  fs.symlinkSync(path.join('releases', id), temporary)
  fs.renameSync(temporary, layout.currentLink)
}

// 留下最新的 keep 个, 在线的那一个 (回滚之后它可能不在最新的几个里) 也留下; 返回要删的
export const planPrune = (
  ids: readonly ReleaseId[],
  currentId: ReleaseId | null,
  keep = KUN_RELEASES_KEEP
): ReleaseId[] => {
  const newestFirst = [...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const kept = new Set(newestFirst.slice(0, keep))
  if (currentId) {
    kept.add(currentId)
  }
  return newestFirst.filter((id) => !kept.has(id))
}

export const removeRelease = (layout: ReleaseLayout, id: ReleaseId) => {
  if (readCurrentReleaseId(layout) === id) {
    throw new Error(`${id} 是在线的发布, 不能删`)
  }
  const dir = releaseDirOf(layout, id)
  // 先删清单: 删到一半被打断时, 剩下的残缺目录不再被当成发布 (不会成为回滚目标)
  fs.rmSync(path.join(dir, KUN_RELEASE_MANIFEST), { force: true })
  fs.rmSync(dir, { recursive: true, force: true })
}
