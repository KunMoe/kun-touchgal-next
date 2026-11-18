import { describe, expect, it } from 'vitest'
import {
  PUBLIC_VISIBILITY,
  toCacheVariant,
  toPatchWhere,
  toPublicListView,
  toSearchVisibility,
  type ContentLimit,
  type ListView,
  type PatchVisibility
} from '~/server/viewer/patchVisibility'

const LIMITS: (ContentLimit | null)[] = ['sfw', 'nsfw', null]

const blockedWhere = (ids: number[]) => ({
  NOT: { tag: { some: { tag_id: { in: ids } } } }
})

describe('toPatchWhere', () => {
  it.each([
    ['sfw', { content_limit: 'sfw' }],
    ['nsfw', { content_limit: 'nsfw' }],
    [null, {}]
  ] as const)('分级 %s 且无屏蔽标签', (contentLimit, expected) => {
    expect(toPatchWhere({ contentLimit, blockedTagIds: [] })).toEqual(expected)
  })

  it('屏蔽标签升序进 NOT, 不改动传入的数组', () => {
    const blockedTagIds = [3, 1, 2]

    expect(toPatchWhere({ contentLimit: 'sfw', blockedTagIds })).toEqual({
      content_limit: 'sfw',
      ...blockedWhere([1, 2, 3])
    })
    expect(toPatchWhere({ contentLimit: null, blockedTagIds })).toEqual(
      blockedWhere([1, 2, 3])
    )
    expect(blockedTagIds).toEqual([3, 1, 2])
  })

  it('未登录视角是 sfw 且不带屏蔽标签', () => {
    expect(toPatchWhere(PUBLIC_VISIBILITY)).toEqual({ content_limit: 'sfw' })
  })
})

describe('toSearchVisibility', () => {
  it('给出与 toPatchWhere 同一个视角的原始值, 且是副本', () => {
    const visibility: PatchVisibility = {
      contentLimit: 'nsfw',
      blockedTagIds: [7, 8]
    }
    const search = toSearchVisibility(visibility)

    expect(search).toEqual({ contentLimit: 'nsfw', blockedTagIds: [7, 8] })
    search.blockedTagIds.push(9)
    expect(visibility.blockedTagIds).toEqual([7, 8])
  })
})

describe('toPublicListView', () => {
  it.each(LIMITS)('无屏蔽标签的 %s 视角可共享', (contentLimit) => {
    expect(toPublicListView({ contentLimit, blockedTagIds: [] })).toEqual({
      kind: 'shared',
      visibility: { contentLimit, blockedTagIds: [] }
    })
  })

  it.each(LIMITS)('带任何屏蔽标签的 %s 视角都不可共享', (contentLimit) => {
    for (const blockedTagIds of [
      [1],
      [9, 3],
      Array.from({ length: 400 }, (_, i) => i + 1)
    ]) {
      expect(toPublicListView({ contentLimit, blockedTagIds })).toEqual({
        kind: 'filtered',
        visibility: { contentLimit, blockedTagIds }
      })
    }
  })
})

describe('toCacheVariant', () => {
  // 键里的视角段必须与此前由 where 反推出来的逐字节相同, 否则上线即全量冷启动
  it.each([
    ['sfw', 'sfw:'],
    ['nsfw', 'nsfw:'],
    [null, 'all:']
  ] as const)('%s 的共享视角对应视角段 %s', (contentLimit, variant) => {
    const view = toPublicListView({ contentLimit, blockedTagIds: [] })

    expect(view.kind === 'shared' && toCacheVariant(view)).toBe(variant)
  })

  // 视角段只从视角自己的 visibility 算: 手写的 shared 视角也拿不到与查询条件不一致的键
  it('手写的 shared 视角, 键与查询条件仍出自同一个 visibility', () => {
    const handBuilt: ListView = {
      kind: 'shared',
      visibility: { contentLimit: null, blockedTagIds: [] }
    }

    expect(toCacheVariant(handBuilt)).toBe('all:')
    expect(toPatchWhere(handBuilt.visibility)).toEqual({})
  })
})

describe('类型约束', () => {
  it('shared 没有 viewer, 屏蔽标签只能为空; 只有 shared 有视角段; 作品列表拿不到 personal', () => {
    const shared: ListView = {
      kind: 'shared',
      visibility: { contentLimit: 'sfw', blockedTagIds: [] }
    }
    // @ts-expect-error 带屏蔽标签的视角不能标成 shared
    const withBlockedTags: ListView = {
      kind: 'shared',
      visibility: { contentLimit: 'sfw', blockedTagIds: [1] }
    }
    const withViewer: ListView = {
      kind: 'shared',
      visibility: { contentLimit: 'sfw', blockedTagIds: [] },
      // @ts-expect-error shared 分支没有 viewer 字段
      viewer: { uid: 1, role: 4 }
    }
    const filtered: ListView = {
      kind: 'filtered',
      visibility: { contentLimit: 'sfw', blockedTagIds: [1] }
    }
    const personal: ListView = {
      kind: 'personal',
      visibility: { contentLimit: 'sfw', blockedTagIds: [] },
      viewer: { uid: 1, role: 4 }
    }
    // @ts-expect-error filtered 视角没有共享缓存的视角段
    toCacheVariant(filtered)
    // @ts-expect-error personal 视角没有共享缓存的视角段
    toCacheVariant(personal)
    const view = toPublicListView(PUBLIC_VISIBILITY)
    // @ts-expect-error toPublicListView 的结果里没有 personal
    const isPersonal = view.kind === 'personal'

    expect([shared.kind, withBlockedTags.kind, withViewer.kind]).toEqual([
      'shared',
      'shared',
      'shared'
    ])
    expect(isPersonal).toBe(false)
  })
})
