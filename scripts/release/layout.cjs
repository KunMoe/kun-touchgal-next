// 发布根的位置只在这里定: ecosystem.config.cjs (PM2 读取, 只能是 CommonJS) 与 scripts/release/*.ts 共用。
//
// 在线发布必须在检出之外: standalone 里缺的模块会沿目录向上解析, 发布若在检出里面, 向上就会落进
// 检出的 node_modules, 缺失被悄悄补上, 检出里的 pnpm install 也会改到在线发布实际加载的模块。
// 放在检出旁边的 <检出目录名>-releases: 与检出在同一个文件系统 (发布靠 rename 移进来, 旧发布的
// 静态资源靠硬链接带过去, 两者都不能跨文件系统), 又不需要另配路径
const path = require('path')

/**
 * @param {string} root 发布根
 * @returns {{ root: string, releasesDir: string, currentLink: string }}
 */
const kunReleaseLayoutAt = (root) => ({
  root,
  releasesDir: path.join(root, 'releases'),
  currentLink: path.join(root, 'current')
})

/**
 * @param {string} repoDir 检出的根目录
 */
const kunReleaseLayout = (repoDir) =>
  kunReleaseLayoutAt(
    path.join(path.dirname(repoDir), `${path.basename(repoDir)}-releases`)
  )

module.exports = { kunReleaseLayout, kunReleaseLayoutAt }
