// pnpm deploy:list: 列出发布根里的发布 (新的在前) 与在线的是哪一个
import {
  kunRepoReleaseLayout,
  listReleases,
  readCurrentReleaseId
} from './layout'

const layout = kunRepoReleaseLayout(process.cwd())
const current = readCurrentReleaseId(layout)
const releases = listReleases(layout)

console.log(`发布根: ${layout.root}`)
if (current === null) {
  console.log('current: (还没有切到发布布局, 在线的是检出里的旧构建)')
} else if (!releases.some((manifest) => manifest.id === current)) {
  console.log(`current: ${current} (清单缺失或损坏)`)
}
if (releases.length === 0) {
  console.log('(还没有发布)')
}
for (const manifest of releases) {
  const marker = manifest.id === current ? '  ← current' : ''
  console.log(
    `${manifest.id}  ${manifest.gitSha.slice(0, 12)}  ${manifest.builtAt}  ${manifest.node}${marker}`
  )
}
