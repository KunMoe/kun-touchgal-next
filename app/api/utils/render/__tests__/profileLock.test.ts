import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderKunMarkdown } from '~/app/api/utils/render/renderKunMarkdown'
import { kunMarkdownCorpus } from './fixtures/markdownCorpus'
import type { KunMarkdownProfile } from '~/app/api/utils/render/renderKunMarkdown'

// 策略版本锁: 同一个版本号下, 语料的渲染输出不许变。
//
// 落库的评论 HTML 与各级渲染缓存都按 profile 的版本号判断新旧。处理器、净化策略、
// 插件或依赖升级只要改变了输出, 就必须递增该 profile 的版本, 否则旧策略渲染的 HTML
// 会继续被当作最新的供出去。这条规则以前只写在注释里, 这里把它变成会失败的测试。
//
// 这条测试失败时:
// 1. 输出变化是有意的 → 递增对应 profile 的版本 (评论还要在发布后跑
//    `pnpm backfill:comment-html`), 再重新生成锁文件:
//      KUN_UPDATE_PROFILE_LOCK=1 pnpm exec vitest run app/api/utils/render/__tests__/profileLock.test.ts
// 2. 输出变化不是有意的 → 那就是回归, 修代码, 不要动锁文件。
// 只增删语料、没改渲染时, 直接重新生成即可; 生成器同样拒绝在版本不变时改写已有摘要

const PROFILES: KunMarkdownProfile[] = ['comment', 'note', 'introduction']
const LOCK_FILE = fileURLToPath(
  new URL('./fixtures/profile-lock.json', import.meta.url)
)
const UPDATE = process.env.KUN_UPDATE_PROFILE_LOCK === '1'

interface ProfileLock {
  version: number
  // 语料 id → 输出的 sha256 前 16 位
  outputs: Record<string, string>
}

type LockFile = Partial<Record<KunMarkdownProfile, ProfileLock>>

const readLock = (): LockFile =>
  existsSync(LOCK_FILE)
    ? (JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as LockFile)
    : {}

const snapshot = async (profile: KunMarkdownProfile): Promise<ProfileLock> => {
  const outputs: Record<string, string> = {}
  let version = 0
  for (const entry of kunMarkdownCorpus) {
    const result = await renderKunMarkdown(profile, entry.markdown, {
      cache: false
    })
    version = result.version
    outputs[entry.id] = createHash('sha256')
      .update(result.html)
      .digest('hex')
      .slice(0, 16)
  }
  return { version, outputs }
}

// 版本没变、两边都有、摘要却不同的语料
const changedUnderSameVersion = (
  locked: ProfileLock | undefined,
  current: ProfileLock
) =>
  locked?.version === current.version
    ? Object.keys(current.outputs).filter(
        (id) =>
          locked.outputs[id] !== undefined &&
          locked.outputs[id] !== current.outputs[id]
      )
    : []

describe.skipIf(UPDATE).each(PROFILES)('%s profile 的策略版本锁', (profile) => {
  it('同一版本下语料的输出不变', async () => {
    const current = await snapshot(profile)
    const locked = readLock()[profile]

    expect(
      changedUnderSameVersion(locked, current),
      `${profile} 的版本仍是 ${current.version}, 这些语料的输出却变了。有意为之就递增版本, 见本文件头注释`
    ).toEqual([])
  })

  it('锁文件与当前版本、语料一致', async () => {
    expect(
      readLock()[profile],
      '锁文件落后于当前版本或语料, 按本文件头注释重新生成'
    ).toEqual(await snapshot(profile))
  })
})

describe.runIf(UPDATE)('重新生成策略版本锁', () => {
  it('写入锁文件', async () => {
    const locked = readLock()
    const next: LockFile = {}
    for (const profile of PROFILES) {
      const current = await snapshot(profile)
      expect(
        changedUnderSameVersion(locked[profile], current),
        `${profile} 的版本仍是 ${current.version}, 这些语料的输出却变了: 先递增版本再生成`
      ).toEqual([])
      next[profile] = current
    }

    writeFileSync(LOCK_FILE, `${JSON.stringify(next, null, 2)}\n`)
  })
})
