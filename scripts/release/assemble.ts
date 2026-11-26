// 把检出里刚构建好的 standalone 整体移进发布根, 组装成一个发布: 记下它自己的静态资源、在它自己的
// .env 里写上发布 id 与提交号、从更早的发布带过旧的静态资源, 最后写清单。清单最后写: 没有清单的
// 目录不算发布 (见 layout.ts 的 listReleases), 中途失败也不会被当成可以上线或回滚的发布
import fs from 'fs'
import path from 'path'
import {
  KUN_RELEASE_STATIC_OWN,
  listReleases,
  makeReleaseId,
  releaseDirOf,
  removeRelease,
  writeReleaseManifest
} from './layout'
import { carryOverStatic, listStaticFiles } from './static'
import type { ReleaseId, ReleaseLayout, ReleaseManifest } from './layout'

export interface AssembleReleaseOptions {
  layout: ReleaseLayout
  // 检出里的 <distDir>/standalone, 整体移走
  standaloneDir: string
  distDir: string
  gitSha: string
  now: Date
  // 构建时的 process.version
  node: string
}

const pathExists = (target: string) => {
  try {
    fs.lstatSync(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

// 这个发布自己构建出的静态资源; 没有这份清单的发布 (只可能是手工动过) 当作没有可带的
export const readStaticOwn = (releaseDir: string): string[] => {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(releaseDir, KUN_RELEASE_STATIC_OWN), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  return raw.split('\n').filter((line) => line !== '')
}

// /api/health 与日志的信封从环境变量读在线的发布。写进发布自己的 .env 而不是 PM2 的 env: 拿旧的
// dump 做 pm2 resurrect 时它也仍然是真的。Next 与 dotenv 都不覆盖进程里已有的变量, 同一个文件里
// 重复的键后写的生效, 所以追加在末尾
const appendReleaseEnv = (envPath: string, id: ReleaseId, gitSha: string) => {
  let existing = ''
  try {
    existing = fs.readFileSync(envPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  fs.appendFileSync(
    envPath,
    `${separator}# 以下两行由发布组装 (scripts/release/assemble.ts) 写入, 不要手改\n` +
      `KUN_RELEASE_ID=${id}\n` +
      `KUN_RELEASE_SHA=${gitSha}\n`
  )
}

export const assembleRelease = ({
  layout,
  standaloneDir,
  distDir,
  gitSha,
  now,
  node
}: AssembleReleaseOptions): ReleaseManifest => {
  const id = makeReleaseId(now, gitSha)
  const sha = gitSha.trim().toLowerCase()
  fs.mkdirSync(layout.releasesDir, { recursive: true })
  const dir = releaseDirOf(layout, id)
  if (pathExists(dir)) {
    throw new Error(`${dir} 已经存在, 不覆盖已有的发布`)
  }

  try {
    fs.renameSync(standaloneDir, dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      throw new Error(
        `无法把 ${standaloneDir} 移到 ${dir}: 两者不在同一个文件系统上。发布靠 rename 移进发布根、` +
          `旧发布的静态资源靠硬链接带过去, 都不能跨文件系统; 发布根 ${layout.root} 必须与检出在同一个文件系统上`,
        { cause: error }
      )
    }
    throw error
  }

  // 移进来之后的任何一步失败都删掉这个目录: 没有清单的目录不会被列为发布, 也就不会被清理, 留着只占盘
  try {
    const distRoot = path.join(dir, distDir)
    const nextBuildId = fs
      .readFileSync(path.join(distRoot, 'BUILD_ID'), 'utf8')
      .trim()

    // 先于带入旧文件清点: 清单里只有这次构建自己的文件
    const staticDir = path.join(distRoot, 'static')
    const own = listStaticFiles(staticDir)
    fs.writeFileSync(
      path.join(dir, KUN_RELEASE_STATIC_OWN),
      own.map((file) => `${file}\n`).join('')
    )

    appendReleaseEnv(path.join(dir, '.env'), id, sha)

    // 新发布还没有清单, 不在 listReleases 里; 各发布按自己的 distDir 找静态目录
    carryOverStatic(
      staticDir,
      listReleases(layout).map((manifest) => {
        const releaseDir = releaseDirOf(layout, manifest.id)
        return {
          staticDir: path.join(releaseDir, manifest.distDir, 'static'),
          files: readStaticOwn(releaseDir)
        }
      })
    )

    const manifest: ReleaseManifest = {
      id,
      gitSha: sha,
      builtAt: now.toISOString(),
      node,
      nextBuildId,
      distDir
    }
    writeReleaseManifest(dir, manifest)
    return manifest
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

// 金丝雀没通过的发布从没上线过, 直接删掉; 在线的那一个由 removeRelease 拒绝
export const discardRelease = (layout: ReleaseLayout, id: ReleaseId) => {
  removeRelease(layout, id)
}
