import { describe, expect, it } from 'vitest'
import { createRewriteFormStore } from '~/store/rewriteStore'
import type { GalgameRewriteInitial } from '~/types/api/edit'

const createInitial = (
  overrides: Partial<GalgameRewriteInitial> = {}
): GalgameRewriteInitial => ({
  id: 5,
  uniqueId: 'abcd1234',
  name: '测试 Galgame',
  introduction: '# 介绍原文',
  released: '2019-10-07',
  contentLimit: 'nsfw',
  alias: ['别名一', '别名二'],
  externalIds: {
    vndbId: 'v19658',
    vndbRelationId: '',
    bangumiId: '172612',
    steamId: '',
    dlsiteCode: 'RJ01405813'
  },
  tags: [
    { id: 11, name: '纯爱' },
    { id: 12, name: '治愈，催泪' }
  ],
  baseFingerprint: 'a'.repeat(64),
  ...overrides
})

describe('createRewriteFormStore', () => {
  // 编辑器只在初始化时读一次介绍原文: 不能等挂载之后再用 effect 灌值
  it('建好的那一刻就带着页面读到的基线', () => {
    const { data } = createRewriteFormStore(createInitial()).getState()

    expect(data).toMatchObject({
      id: 5,
      uniqueId: 'abcd1234',
      name: '测试 Galgame',
      introduction: '# 介绍原文',
      released: '2019-10-07',
      contentLimit: 'nsfw',
      alias: ['别名一', '别名二'],
      vndbId: 'v19658',
      vndbRelationId: '',
      bangumiId: '172612',
      steamId: '',
      dlsiteCode: 'RJ01405813'
    })
  })

  // 现存标签不进 tag: 它经逗号文本框编辑, 名字里带逗号的标签会被拆碎
  it('现存标签只作为可按 id 移除的基线, 表单里的新增与移除从空开始', () => {
    const state = createRewriteFormStore(createInitial()).getState()

    expect(state.existingTags).toEqual([
      { id: 11, name: '纯爱' },
      { id: 12, name: '治愈，催泪' }
    ])
    expect(state.data.tag).toEqual([])
    expect(state.data.removeTagIds).toEqual([])
    expect(state.baseFingerprint).toBe('a'.repeat(64))
  })

  it('每次创建都是独立实例, 上一个游戏的表单不会带到下一个', () => {
    const first = createRewriteFormStore(createInitial())
    const second = createRewriteFormStore(
      createInitial({ id: 6, uniqueId: 'wxyz5678', name: '另一个游戏' })
    )

    first.getState().update({ name: '改过的名字', removeTagIds: [11] })

    expect(second.getState().data).toMatchObject({
      id: 6,
      name: '另一个游戏',
      removeTagIds: []
    })
  })

  it('函数式写入基于最新状态, 且不动基线', () => {
    const store = createRewriteFormStore(createInitial())
    const { update } = store.getState()

    update((prev) => ({ removeTagIds: [...prev.removeTagIds, 11] }))
    update((prev) => ({ removeTagIds: [...prev.removeTagIds, 12] }))
    update({ tag: ['新标签'] })

    expect(store.getState().data).toMatchObject({
      removeTagIds: [11, 12],
      tag: ['新标签'],
      name: '测试 Galgame'
    })
    expect(store.getState().existingTags).toHaveLength(2)
    expect(store.getState().baseFingerprint).toBe('a'.repeat(64))
  })
})
