import { describe, expect, it } from 'vitest'
import {
  PUBLIC_VISIBILITY,
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
  // 键里的视角段必须与此前由 where 反推出来的逐字节相同, 否则上线即全量冷启动
  it.each([
    ['sfw', 'sfw:'],
    ['nsfw', 'nsfw:'],
    [null, 'all:']
  ] as const)(
    '无屏蔽标签的 %s 视角可共享, 视角段是 %s',
    (contentLimit, variant) => {
      const view = toPublicListView({ contentLimit, blockedTagIds: [] })

      expect(view).toEqual({
        kind: 'shared',
        visibility: { contentLimit, blockedTagIds: [] },
        cacheVariant: variant
      })
    }
  )

  it.each(LIMITS)(
    '带任何屏蔽标签的 %s 视角都不可共享, 也没有视角段',
    (contentLimit) => {
      for (const blockedTagIds of [
        [1],
        [9, 3],
        Array.from({ length: 400 }, (_, i) => i + 1)
      ]) {
        const view = toPublicListView({ contentLimit, blockedTagIds })

        expect(view).toEqual({
          kind: 'filtered',
          visibility: { contentLimit, blockedTagIds }
        })
        expect(view).not.toHaveProperty('cacheVariant')
      }
    }
  )

  it('类型上: shared 没有 viewer, 屏蔽标签只能为空; 作品列表拿不到 personal', () => {
    const shared: ListView = {
      kind: 'shared',
      visibility: { contentLimit: 'sfw', blockedTagIds: [] },
      cacheVariant: 'sfw:'
    }
    // @ts-expect-error 带屏蔽标签的视角不能标成 shared
    const withBlockedTags: ListView = {
      kind: 'shared',
      visibility: { contentLimit: 'sfw', blockedTagIds: [1] },
      cacheVariant: 'sfw:'
    }
    const withViewer: ListView = {
      kind: 'shared',
      visibility: { contentLimit: 'sfw', blockedTagIds: [] },
      cacheVariant: 'sfw:',
      // @ts-expect-error shared 分支没有 viewer 字段
      viewer: { uid: 1, role: 4 }
    }
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
