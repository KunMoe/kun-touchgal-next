// pnpm deploy:list: 列出发布根里的发布 (新的在前) 与在线的是哪一个
import { isReleaseActivated, isReleaseRolledBack } from './history'
import {
  kunRepoReleaseLayout,
  listReleases,
  readCurrentReleaseId
} from './layout'
import type { ReleaseId } from './layout'

const layout = kunRepoReleaseLayout(process.cwd())
const releases = listReleases(layout)

console.log(`发布根: ${layout.root}`)
let current: string | null = null
let currentError: string | null = null
try {
  current = readCurrentReleaseId(layout)
} catch (error) {
  currentError = error instanceof Error ? error.message : String(error)
}
if (currentError !== null) {
  console.log(`current: 认不出 (${currentError})`)
  process.exitCode = 1
} else if (current === null) {
  console.log('current: (还没有切到发布布局, 在线的是检出里的旧构建)')
} else if (!releases.some((manifest) => manifest.id === current)) {
  console.log(`current: ${current} (清单缺失或损坏)`)
}
if (releases.length === 0) {
  console.log('(还没有发布)')
}
// 已上线 / 被回滚: deploy:rollback 不给 id 时只回到「上线过且没被回滚」的发布
const verdictOf = (id: ReleaseId) =>
  isReleaseRolledBack(layout, id)
    ? '被回滚'
    : isReleaseActivated(layout, id)
      ? '上线过'
      : '没上线'
for (const manifest of releases) {
  const marker = manifest.id === current ? '  ← current' : ''
  console.log(
    `${manifest.id}  ${manifest.gitSha.slice(0, 12)}  ${manifest.builtAt}  ${manifest.node}  ${verdictOf(manifest.id)}${marker}`
  )
}
