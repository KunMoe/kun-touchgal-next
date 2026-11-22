import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  commentPage: vi.fn(),
  patchContent: vi.fn(),
  patchContentById: vi.fn(),
  resourceDetail: vi.fn(),
  resourceList: vi.fn(),
  resourceStatsList: vi.fn(),
  pendingResource: vi.fn(),
  tagList: vi.fn(),
  companyList: vi.fn()
}))

vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: mocks.commentPage
}))
vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: mocks.patchContent,
  invalidatePatchContentCacheByPatchId: mocks.patchContentById
}))
vi.mock('~/app/api/patch/resource/cache', () => ({
  invalidatePatchResourceDetailCache: mocks.resourceDetail
}))
vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: mocks.resourceList,
  invalidateResourceStatsListCache: mocks.resourceStatsList
}))
vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: mocks.pendingResource
}))
vi.mock('~/app/api/tag/cache', () => ({
  invalidateTagListCache: mocks.tagList
}))
vi.mock('~/app/api/company/cache', () => ({
  invalidateCompanyListCache: mocks.companyList
}))

import { recordKunChanges } from '~/server/cache/publish'
import type { KunChange } from '~/server/cache/changes'

const comment = (patchId: number): KunChange => ({
  kind: 'comment',
  id: patchId,
  patchId,
  resourceId: null,
  before: 0,
  after: null
})

// 一次写入能产出的全部目标种类
const everything: KunChange[] = [
  comment(30),
  comment(10),
  { kind: 'patch', patchId: 20, uniqueId: 'u20' },
  { kind: 'patchDeleted', patchId: 40, uniqueId: 'u40' },
  {
    kind: 'resource',
    id: 1,
    patchId: 10,
    ownerId: 9,
    before: { status: 2, section: 'patch' },
    after: { status: 0, section: 'patch' }
  },
  {
    kind: 'resource',
    id: 2,
    patchId: 30,
    ownerId: 5,
    before: { status: 3, section: 'galgame' },
    after: null
  },
  { kind: 'resourceReaction', patchId: 10, reaction: 'download' }
]

const record = (changes: KunChange[]) => {
  const registered: Array<[string, () => unknown]> = []
  recordKunChanges(
    { afterCommit: (key, effect) => registered.push([key, effect]) },
    changes
  )
  return registered
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('recordKunChanges', () => {
  it('只登记, 提交之前不执行任何失效', () => {
    record(everything)

    for (const mock of Object.values(mocks)) {
      expect(mock).not.toHaveBeenCalled()
    }
  })

  it('key 带上缓存种类与作用的 id, 按固定顺序登记', () => {
    expect(record(everything).map(([key]) => key)).toEqual([
      'commentPage:10,30',
      'patchContent:unique:u20',
      'patchContent:unique:u40',
      'patchContent:10,30',
      'resourceDetail:10',
      'resourceList',
      'resourceStatsList',
      'pendingResource:5,9',
      'tagList',
      'companyList'
    ])
  })

  it('执行时沿用各 helper 原来的调用形状', async () => {
    for (const [, effect] of record(everything)) {
      await effect()
    }

    expect(mocks.commentPage.mock.calls).toEqual([[10], [30]])
    // 知道 uniqueId 的直接删键; 只有 id 的合成一次回库查询
    expect(mocks.patchContent.mock.calls).toEqual([['u20'], ['u40']])
    expect(mocks.patchContentById.mock.calls).toEqual([[[10, 30]]])
    expect(mocks.resourceDetail.mock.calls).toEqual([[10]])
    expect(mocks.resourceList).toHaveBeenCalledTimes(1)
    expect(mocks.resourceStatsList).toHaveBeenCalledTimes(1)
    expect(mocks.pendingResource.mock.calls).toEqual([[5], [9]])
    expect(mocks.tagList).toHaveBeenCalledTimes(1)
    expect(mocks.companyList).toHaveBeenCalledTimes(1)
  })

  it('没有要失效的缓存时不登记', () => {
    expect(
      record([
        {
          kind: 'resource',
          id: 1,
          patchId: 10,
          ownerId: 9,
          before: { status: 1, section: 'patch' },
          after: null
        }
      ])
    ).toEqual([])
  })
})
