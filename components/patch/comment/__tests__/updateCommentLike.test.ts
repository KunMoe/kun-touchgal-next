import { describe, expect, it } from 'vitest'
import { updateCommentLike } from '~/components/patch/comment/updateCommentLike'
import type { PatchComment } from '~/types/api/patch'

const comment = (
  id: number,
  parentId: number | null,
  like: { isLike: boolean; likeCount: number } = { isLike: false, likeCount: 0 }
): PatchComment => ({
  id,
  uniqueId: 'p',
  content: `c${id}`,
  isSpoiler: false,
  status: 0,
  parentId,
  userId: 1,
  patchId: 1,
  created: '',
  updated: '',
  reply: [],
  user: { id: 1, name: 'a', avatar: '' },
  ...like
})

const root = (id: number, reply: PatchComment[] = []) => ({
  ...comment(id, null),
  reply
})

describe('updateCommentLike', () => {
  it('点赞根评论: 置位并加一', () => {
    const next = updateCommentLike([root(1), root(2)], 1, true)

    expect(next[0]).toMatchObject({ isLike: true, likeCount: 1 })
    expect(next[1]).toMatchObject({ isLike: false, likeCount: 0 })
  })

  it('点赞回复: 只改那一条, 其他根评论引用不变', () => {
    const prev = [root(1, [comment(11, 1), comment(12, 1)]), root(2)]

    const next = updateCommentLike(prev, 12, true)

    expect(next[0].reply[0]).toBe(prev[0].reply[0])
    expect(next[0].reply[1]).toMatchObject({ isLike: true, likeCount: 1 })
    expect(next[1]).toBe(prev[1])
  })

  it('取消点赞: 复位并减一', () => {
    const prev = [root(1, [comment(11, 1, { isLike: true, likeCount: 5 })])]

    const next = updateCommentLike(prev, 11, false)

    expect(next[0].reply[0]).toMatchObject({ isLike: false, likeCount: 4 })
  })

  it('服务端结果与本地一致: 计数不重复增减', () => {
    const prev = [root(1, [comment(11, 1, { isLike: true, likeCount: 5 })])]

    const next = updateCommentLike(prev, 11, true)

    expect(next[0].reply[0]).toMatchObject({ isLike: true, likeCount: 5 })
  })

  it('目标不在本页: 原样返回各评论', () => {
    const prev = [root(1, [comment(11, 1)])]

    const next = updateCommentLike(prev, 99, true)

    expect(next[0]).toBe(prev[0])
  })
})
