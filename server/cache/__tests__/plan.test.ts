import { describe, expect, it } from 'vitest'
import {
  KUN_TTL_TOLERATED,
  planKunInvalidations,
  resourceTransition
} from '~/server/cache/plan'
import type { KunChange, KunResourceState } from '~/server/cache/changes'
import type { KunCacheTarget } from '~/server/cache/plan'
import type { ResourceStatus } from '~/constants/contentStatus'

// 规划器的黄金表: 每行是一个写路径场景报告的变更, 与它提交后应失效的缓存。
// 目标写成 种类[:patchId][@uniqueId][#uid], 按字典序比较
const fmt = (target: KunCacheTarget) => {
  switch (target.cache) {
    case 'commentPage':
    case 'resourceDetail':
      return `${target.cache}:${target.patchId}`
    case 'patchContent':
      return `${target.cache}:${target.patchId}${target.uniqueId ? `@${target.uniqueId}` : ''}`
    case 'pendingResource':
      return `${target.cache}#${target.uid}`
    default:
      return target.cache
  }
}
const plan = (changes: KunChange[]) =>
  planKunInvalidations(changes).map(fmt).sort()

const P = 10
const OWNER = 7
const state = (
  status: ResourceStatus,
  section = 'patch'
): KunResourceState => ({
  status,
  section
})
const resource = (
  before: KunResourceState | null,
  after: KunResourceState | null,
  patchId = P
): KunChange => ({
  kind: 'resource',
  id: 1,
  patchId,
  ownerId: OWNER,
  before,
  after
})
const recalc: KunChange = { kind: 'patch', patchId: P, uniqueId: 'u10' }

const CONTENT = `patchContent:${P}@u10`
const DETAIL = `resourceDetail:${P}`
const LIST = 'resourceList'
const PENDING = `pendingResource#${OWNER}`

describe('资源的写入场景 (资源闸门)', () => {
  it.each<[string, KunChange[], string[]]>([
    // 前台新建: 公开 / 待初审 / 被审核拦截, 两个 section
    [
      '新建公开 patch 资源',
      [recalc, resource(null, state(0))],
      [CONTENT, DETAIL, LIST]
    ],
    [
      '新建公开 galgame 资源',
      [recalc, resource(null, state(0, 'galgame'))],
      [CONTENT, DETAIL]
    ],
    ['新建待初审资源', [recalc, resource(null, state(2))], [CONTENT, PENDING]],
    [
      '新建被拦截资源',
      [recalc, resource(null, state(3, 'galgame'))],
      [CONTENT, PENDING]
    ],
    // 前台编辑: 编辑只会写 status=3 (被拦截) 或不改 status
    [
      '编辑公开资源',
      [recalc, resource(state(0), state(0))],
      [CONTENT, DETAIL, LIST]
    ],
    [
      '公开资源改 section 到 galgame',
      [recalc, resource(state(0), state(0, 'galgame'))],
      [CONTENT, DETAIL, LIST]
    ],
    [
      '编辑公开资源被拦截',
      [recalc, resource(state(0, 'galgame'), state(3, 'galgame'))],
      [CONTENT, DETAIL, PENDING]
    ],
    [
      '管理员编辑待审资源被拦截',
      [recalc, resource(state(3), state(3))],
      [CONTENT]
    ],
    ['管理员编辑待初审资源', [recalc, resource(state(2), state(2))], [CONTENT]],
    // 删除 (前台与后台), 以及守卫删除: 初审拒绝只匹配 2, 申诉驳回只匹配 1
    [
      '删除公开 patch 资源',
      [recalc, resource(state(0), null)],
      [CONTENT, DETAIL, LIST]
    ],
    [
      '删除公开 galgame 资源',
      [recalc, resource(state(0, 'galgame'), null)],
      [CONTENT, DETAIL]
    ],
    ['删除隐藏资源 (申诉驳回)', [recalc, resource(state(1), null)], [CONTENT]],
    [
      '删除待初审资源 (初审拒绝)',
      [recalc, resource(state(2), null)],
      [CONTENT, PENDING]
    ],
    ['删除待审核资源', [recalc, resource(state(3), null)], [CONTENT, PENDING]],
    // 状态迁移: 隐藏、恢复、初审通过、审核裁决、申诉通过
    [
      '隐藏公开资源',
      [recalc, resource(state(0), state(1))],
      [CONTENT, DETAIL, LIST]
    ],
    [
      '恢复隐藏的 galgame 资源',
      [recalc, resource(state(1, 'galgame'), state(0, 'galgame'))],
      [CONTENT, DETAIL]
    ],
    [
      '初审通过',
      [recalc, resource(state(2), state(0))],
      [CONTENT, DETAIL, LIST, PENDING]
    ],
    [
      '审核放行',
      [recalc, resource(state(3, 'galgame'), state(0, 'galgame'))],
      [CONTENT, DETAIL, PENDING]
    ],
    // 3→1 不碰公开缓存 (HEAD 之前的 apply 无条件失效列表, 是多余的)
    [
      '审核拒绝转隐藏',
      [recalc, resource(state(3), state(1))],
      [CONTENT, PENDING]
    ],
    [
      '申诉通过',
      [recalc, resource(state(1), state(0))],
      [CONTENT, DETAIL, LIST]
    ]
  ])('%s', (_name, changes, expected) => {
    expect(plan(changes)).toEqual([...expected].sort())
  })
})

describe('资源计数', () => {
  it('点赞失效统计列表与资源详情', () => {
    expect(
      plan([{ kind: 'resourceReaction', patchId: P, reaction: 'like' }])
    ).toEqual([DETAIL, 'resourceStatsList'])
  })

  // 详情内嵌的下载数没有界面消费方, 而下载是这份缓存最高频的写入
  it('下载只失效统计列表', () => {
    expect(
      plan([{ kind: 'resourceReaction', patchId: P, reaction: 'download' }])
    ).toEqual(['resourceStatsList'])
  })
})

describe('补丁删除', () => {
  const deleted: KunChange = {
    kind: 'patchDeleted',
    patchId: P,
    uniqueId: 'u10'
  }

  it('失效详情两键与标签 / 会社列表, 列表闸门看随级联消失的资源', () => {
    expect(
      plan([
        deleted,
        resource(state(0), null),
        resource(state(0, 'galgame'), null),
        resource(state(3), null)
      ])
    ).toEqual([CONTENT, 'companyList', PENDING, LIST, 'tagList'].sort())
  })

  it('没有公开的 patch 资源时不失效资源列表', () => {
    expect(plan([deleted, resource(state(1), null)])).toEqual(
      [CONTENT, 'companyList', 'tagList'].sort()
    )
  })

  // 被删 patch 的资源详情版本键已不可达; 同一批里别的 patch 照常失效
  it('跳过被删 patch 的资源详情, 不影响别的 patch', () => {
    expect(
      plan([
        deleted,
        resource(state(0, 'galgame'), null),
        resource(state(0, 'galgame'), null, 11)
      ])
    ).toEqual([CONTENT, 'companyList', 'resourceDetail:11', 'tagList'].sort())
  })
})

describe('标签 / 会社与收藏', () => {
  it.each<[string, KunChange]>([
    [
      '标签改名',
      { kind: 'taxonomyRenamed', taxonomy: 'tag', patchIds: [12, P] }
    ],
    [
      '会社删除',
      { kind: 'taxonomyDeleted', taxonomy: 'company', patchIds: [12, P] }
    ],
    ['删收藏夹', { kind: 'favoritesRemoved', patchIds: [12, P] }]
  ])('%s: 失效全部关联补丁的详情两键, 按 id 回库查', (_name, change) => {
    expect(plan([change])).toEqual([`patchContent:${P}`, 'patchContent:12'])
  })

  it('没有关联补丁时没有目标', () => {
    expect(
      plan([{ kind: 'taxonomyDeleted', taxonomy: 'tag', patchIds: [] }])
    ).toEqual([])
  })
})

describe('内容行 (评论 / 评价) 的补丁详情失效按 id 回库查', () => {
  it('非资源评论进出公开集', () => {
    expect(
      plan([
        {
          kind: 'comment',
          id: 1,
          patchId: P,
          resourceId: null,
          before: 0,
          after: null
        }
      ])
    ).toEqual([`commentPage:${P}`, `patchContent:${P}`])
  })

  it('同一 patch 还报告了 patch 变更时只留带 uniqueId 的那条, 与报告顺序无关', () => {
    const rating: KunChange = {
      kind: 'rating',
      patchId: P,
      before: 0,
      after: 2,
      scoreChanged: false
    }
    expect(plan([rating, recalc])).toEqual([CONTENT])
    expect(plan([recalc, rating])).toEqual([CONTENT])
  })
})

describe('去重', () => {
  it('同一目标只出现一次', () => {
    const targets = planKunInvalidations([
      resource(state(0), state(1)),
      resource(state(0), null),
      { kind: 'resourceReaction', patchId: P, reaction: 'like' },
      { kind: 'resourceReaction', patchId: P, reaction: 'download' }
    ]).map(fmt)
    expect(targets).toEqual([DETAIL, LIST, 'resourceStatsList'])
  })

  it('没有变更就没有目标', () => {
    expect(planKunInvalidations([])).toEqual([])
  })
})

describe('resourceTransition', () => {
  it.each<
    [
      string,
      KunResourceState | null,
      KunResourceState | null,
      [boolean, boolean, boolean]
    ]
  >([
    ['新建公开', null, state(0), [true, true, false]],
    ['公开改 section', state(0), state(0, 'galgame'), [true, true, false]],
    [
      'galgame 资源进出公开集',
      state(1, 'galgame'),
      state(0, 'galgame'),
      [true, false, false]
    ],
    // 2→3 留在「待初审或待审核」集合里, 作者的待审标记不变
    ['待初审转待审核', state(2), state(3), [false, false, false]],
    ['待审核转隐藏', state(3), state(1), [false, false, true]]
  ])(
    '%s',
    (_name, before, after, [touchesPublic, touchesListed, pendingFlip]) => {
      expect(resourceTransition(before, after)).toEqual({
        touchesPublic,
        touchesListed,
        pendingFlip
      })
    }
  )
})

it('未知的变更种类在运行期报错 (穷尽 switch 的兜底)', () => {
  expect(() =>
    planKunInvalidations([{ kind: 'nope' } as unknown as KunChange])
  ).toThrow('未知的缓存变更')
})

// 容忍到 TTL 的论证按 accepted 秒的陈旧写成; 把缓存 TTL 调长到超过它, 就要回来重新论证
describe('KUN_TTL_TOLERATED', () => {
  it.each(KUN_TTL_TOLERATED.map((entry) => [entry.field, entry] as const))(
    '%s: TTL 不超过论证时假定的陈旧上限',
    (_field, entry) => {
      expect(entry.caches.length).toBeGreaterThan(0)
      expect(entry.reason.length).toBeGreaterThan(0)
      expect(entry.ttl).toBeGreaterThan(0)
      expect(entry.ttl).toBeLessThanOrEqual(entry.accepted)
    }
  )
})
