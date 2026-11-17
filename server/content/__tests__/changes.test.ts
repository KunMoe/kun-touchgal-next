import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  commentPageMock,
  patchContentMock,
  resourceDetailMock,
  resourceListMock,
  pendingResourceMock
} = vi.hoisted(() => ({
  commentPageMock: vi.fn(),
  patchContentMock: vi.fn(),
  resourceDetailMock: vi.fn(),
  resourceListMock: vi.fn(),
  pendingResourceMock: vi.fn()
}))

vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: commentPageMock
}))
vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCacheByPatchId: patchContentMock
}))
vi.mock('~/app/api/patch/resource/cache', () => ({
  invalidatePatchResourceDetailCache: resourceDetailMock
}))
vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: resourceListMock
}))
vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: pendingResourceMock
}))

import { recordContentChanges } from '~/server/content/changes'
import type { ContentChange } from '~/server/content/changes'

// 登记后立即按顺序执行全部副作用, 返回登记的 key
const flush = async (changes: ContentChange[]) => {
  const effects: Array<[string, () => unknown]> = []
  recordContentChanges(
    { afterCommit: (key, effect) => effects.push([key, effect]) },
    changes
  )
  for (const [, effect] of effects) {
    await effect()
  }
  return effects.map(([key]) => key)
}

const comment = (
  before: 0 | 1 | 2 | null,
  after: 0 | 1 | 2 | null,
  resourceId: number | null = null,
  patchId = 10
): ContentChange => ({
  kind: 'comment',
  id: 1,
  patchId,
  resourceId,
  before,
  after
})

const rating = (
  before: 0 | 1 | 2 | null,
  after: 0 | 1 | 2 | null,
  scoreChanged = false
): ContentChange => ({
  kind: 'rating',
  patchId: 10,
  before,
  after,
  scoreChanged
})

const resource = (
  before: 0 | 1 | 2 | 3 | null,
  after: 0 | 1 | 2 | 3 | null,
  section = 'patch'
): ContentChange => ({
  kind: 'resource',
  id: 1,
  patchId: 10,
  ownerId: 7,
  before: before === null ? null : { status: before, section },
  after: after === null ? null : { status: after, section }
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('评论变化 → 评论分页缓存与补丁详情缓存', () => {
  it.each([
    ['公开评论被删', comment(0, null), true, true],
    ['待审通过转公开', comment(1, 0), true, true],
    ['隐藏恢复为公开', comment(2, 0), true, true],
    ['公开评论被隐藏', comment(0, 2), true, true],
    ['公开评论编辑后重新送审', comment(0, 1), true, true],
    // 正文变了, 分页缓存里的内容要换; comment_count 不变
    ['公开评论只改正文', comment(0, 0), true, false],
    // 待审与隐藏的评论本就不在公开基线里
    ['待审评论被拒转隐藏', comment(1, 2), false, false],
    ['隐藏评论被删', comment(2, null), false, false],
    ['待审评论被删', comment(1, null), false, false]
  ])('%s', async (_name, change, page, detail) => {
    await flush([change])

    expect(commentPageMock.mock.calls.map(([id]) => id)).toEqual(
      page ? [10] : []
    )
    expect(patchContentMock.mock.calls).toEqual(detail ? [[[10]]] : [])
  })

  // 资源评论不计入 patch.comment_count
  it.each([
    ['资源评论被删', comment(0, null, 5)],
    ['资源评论转公开', comment(1, 0, 5)]
  ])('%s 只失效分页缓存', async (_name, change) => {
    await flush([change])

    expect(commentPageMock).toHaveBeenCalledTimes(1)
    expect(patchContentMock).not.toHaveBeenCalled()
  })
})

describe('评价变化 → 补丁详情缓存', () => {
  it.each([
    ['公开评价被删', rating(0, null), true],
    ['待审通过转公开', rating(1, 0), true],
    ['公开评价被隐藏', rating(0, 2), true],
    ['公开评价改了评分', rating(0, 0, true), true],
    ['公开评价只改文字', rating(0, 0, false), false],
    // 隐藏与待审的评价不计入 ratingSummary
    ['隐藏评价被删', rating(2, null), false],
    ['待审评价被拒', rating(1, 2), false],
    ['待审评价改了评分', rating(1, 1, true), false]
  ])('%s', async (_name, change, detail) => {
    await flush([change])

    expect(patchContentMock.mock.calls).toEqual(detail ? [[[10]]] : [])
    expect(commentPageMock).not.toHaveBeenCalled()
  })
})

describe('资源变化 → 资源详情 / 列表 / 作者待审标记缓存', () => {
  it.each([
    // [名称, 变化, 详情, 列表, 待审标记]
    ['公开的 patch 资源被删', resource(0, null), true, true, false],
    [
      '公开的 galgame 资源被删',
      resource(0, null, 'galgame'),
      true,
      false,
      false
    ],
    ['公开资源被隐藏', resource(0, 1), true, true, false],
    ['隐藏资源恢复公开', resource(1, 0), true, true, false],
    ['待初审通过', resource(2, 0), true, true, true],
    ['待审核通过', resource(3, 0), true, true, true],
    ['待审核被拒转隐藏', resource(3, 1), false, false, true],
    ['公开资源编辑后送审', resource(0, 3), true, true, true],
    // 初审拒绝与申诉驳回的守卫删除: 行不在公开集里
    ['待初审被拒 (删除)', resource(2, null), false, false, true],
    ['隐藏资源被删', resource(1, null), false, false, false],
    ['待审核资源被管理员删', resource(3, null), false, false, true]
  ])('%s', async (_name, change, detail, list, pending) => {
    await flush([change])

    expect(resourceDetailMock.mock.calls.map(([id]) => id)).toEqual(
      detail ? [10] : []
    )
    expect(resourceListMock).toHaveBeenCalledTimes(list ? 1 : 0)
    expect(pendingResourceMock.mock.calls.map(([uid]) => uid)).toEqual(
      pending ? [7] : []
    )
    // 补丁聚合缓存跟随 recalcPatchType, 由命令自己登记
    expect(patchContentMock).not.toHaveBeenCalled()
  })
})

describe('批量与登记顺序', () => {
  it('同一补丁的多条变化只失效一次, 补丁按 id 升序', async () => {
    await flush([
      comment(0, null, null, 30),
      comment(0, null, null, 10),
      comment(0, null, null, 30)
    ])

    expect(commentPageMock.mock.calls.map(([id]) => id)).toEqual([10, 30])
    expect(patchContentMock.mock.calls).toEqual([[[10, 30]]])
  })

  it('没有任何公开集变化时不登记副作用', async () => {
    const keys = await flush([
      comment(1, 2),
      rating(2, null),
      resource(1, null)
    ])

    expect(keys).toEqual([])
  })

  it('key 带上作用的 id, 同一事务里重复登记同一批不会重复执行', async () => {
    const keys = await flush([comment(0, null), resource(2, 0)])

    expect(keys).toEqual([
      'commentPage:10',
      'patchContent:10',
      'resourceDetail:10',
      'resourceList',
      'pendingResource:7'
    ])
  })
})
