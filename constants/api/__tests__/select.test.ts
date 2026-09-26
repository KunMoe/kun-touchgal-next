import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { toGalgameCard } from '../select'

// C55: 首页 / tag / company / search 曾用 `...rest` 展开 select 行, 把 unique_id 与
// rating_stat 一并带进 HTML 与公开 API; 日后加进 select 的字段也会被静默带出
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const CARD_KEYS = [
  '_count',
  'averageRating',
  'banner',
  'created',
  'download',
  'id',
  'language',
  'name',
  'platform',
  'type',
  'uniqueId',
  'view'
]

const row = {
  id: 1,
  unique_id: 'abcd1234',
  name: 'galgame',
  banner: 'https://example.com/banner.avif',
  view: 10,
  download: 3,
  type: ['pc'],
  language: ['zh-Hans'],
  platform: ['windows'],
  created: new Date('2026-09-26T00:00:00Z'),
  favorite_count: 4,
  resource_count: 5,
  comment_count: 6,
  rating_stat: { avg_overall: 8.567 }
}

describe('toGalgameCard', () => {
  it('只输出 GalgameCard 声明的字段, 不带出 select 行的额外字段', () => {
    const card = toGalgameCard({ ...row, content_limit: 'nsfw' } as typeof row)

    expect(Object.keys(card).sort()).toEqual(CARD_KEYS)
    expect(card).toMatchObject({
      uniqueId: 'abcd1234',
      _count: { favorite_folder: 4, resource: 5, comment: 6 },
      averageRating: 8.6
    })
  })

  it('无评分统计时评分为 0', () => {
    expect(toGalgameCard({ ...row, rating_stat: null }).averageRating).toBe(0)
  })

  it('选取 GalgameCardSelectField 的服务端文件都经 toGalgameCard 映射', () => {
    const files = ['app', 'server'].flatMap((dir) =>
      readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf-8' })
        .filter(
          (entry) => /\.tsx?$/.test(entry) && !entry.includes('__tests__')
        )
        .map((entry) => join(dir, entry))
    )
    const selecting = files.filter((file) =>
      readFileSync(join(ROOT, file), 'utf-8').includes('GalgameCardSelectField')
    )

    expect(selecting.length).toBeGreaterThanOrEqual(7)
    for (const file of selecting) {
      const source = readFileSync(join(ROOT, file), 'utf-8')
      expect(source, file).toMatch(/\btoGalgameCard\b/)
      expect(source, file).not.toContain('...rest')
    }
  })
})
