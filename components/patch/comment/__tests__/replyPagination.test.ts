import { describe, expect, it } from 'vitest'
import {
  REPLY_COLLAPSED_COUNT,
  REPLY_LAST_PAGE,
  REPLY_PAGE_SIZE,
  getVisibleReplies,
  locateReplyViews,
  resolveReplyView
} from '~/components/patch/comment/replyPagination'
import type { PatchComment } from '~/types/api/patch'

const comment = (id: number, parentId: number | null): PatchComment => ({
  id,
  uniqueId: 'p',
  content: `c${id}`,
  isLike: false,
  isSpoiler: false,
  status: 0,
  likeCount: 0,
  parentId,
  userId: 1,
  patchId: 1,
  created: '',
  updated: '',
  reply: [],
  user: { id: 1, name: 'a', avatar: '' }
})

// 根评论 rootId 带 replyCount 条回复, 回复 id 为 rootId * 1000 + 1..replyCount
const root = (rootId: number, replyCount: number): PatchComment => ({
  ...comment(rootId, null),
  reply: Array.from({ length: replyCount }, (_, index) =>
    comment(rootId * 1000 + index + 1, rootId)
  )
})

const visibleIds = (
  target: PatchComment,
  view?: Parameters<typeof getVisibleReplies>[1]
) => getVisibleReplies(target.reply, view).map((reply) => reply.id)

describe('resolveReplyView', () => {
  it('回复数不超过预览条数: 不折叠, 全部露出', () => {
    expect(resolveReplyView(REPLY_COLLAPSED_COUNT)).toMatchObject({
      foldable: false,
      expanded: false,
      start: 0,
      end: REPLY_COLLAPSED_COUNT
    })
    expect(resolveReplyView(0)).toMatchObject({ foldable: false, end: 0 })
  })

  it('超过预览条数: 默认折叠, 只露出前几条', () => {
    expect(resolveReplyView(REPLY_COLLAPSED_COUNT + 1)).toMatchObject({
      foldable: true,
      expanded: false,
      start: 0,
      end: REPLY_COLLAPSED_COUNT
    })
  })

  it('展开后按页切片', () => {
    expect(resolveReplyView(23, { expanded: true, page: 1 })).toMatchObject({
      expanded: true,
      page: 1,
      pageCount: 3,
      start: 0,
      end: REPLY_PAGE_SIZE
    })
    expect(resolveReplyView(23, { expanded: true, page: 3 })).toMatchObject({
      page: 3,
      pageCount: 3,
      start: 20
    })
  })

  it('页码钳到有效范围: 删回复后总页数缩水不会停在空页', () => {
    expect(resolveReplyView(11, { expanded: true, page: 5 })).toMatchObject({
      page: 2,
      pageCount: 2,
      start: 10
    })
    expect(resolveReplyView(11, { expanded: true, page: 0 })).toMatchObject({
      page: 1,
      start: 0
    })
  })

  it('回复数恰为整页: 没有多出来的空页', () => {
    expect(resolveReplyView(10, { expanded: true, page: 1 })).toMatchObject({
      page: 1,
      pageCount: 1,
      start: 0
    })
    expect(
      resolveReplyView(20, { expanded: true, page: REPLY_LAST_PAGE })
    ).toMatchObject({ page: 2, pageCount: 2, start: 10 })
  })

  it('收起后写入的 expanded: false 回到折叠预览, 不看页码', () => {
    expect(resolveReplyView(12, { expanded: false, page: 2 })).toMatchObject({
      foldable: true,
      expanded: false,
      start: 0,
      end: REPLY_COLLAPSED_COUNT
    })
  })

  it('REPLY_LAST_PAGE 恒落在末页', () => {
    expect(
      resolveReplyView(23, { expanded: true, page: REPLY_LAST_PAGE })
    ).toMatchObject({ page: 3, pageCount: 3, start: 20 })
    expect(
      resolveReplyView(4, { expanded: true, page: REPLY_LAST_PAGE })
    ).toMatchObject({ page: 1, pageCount: 1, start: 0 })
  })

  it('展开态下回复删到不超过预览条数: 退回不折叠', () => {
    expect(
      resolveReplyView(REPLY_COLLAPSED_COUNT, { expanded: true, page: 2 })
    ).toMatchObject({
      foldable: false,
      expanded: false,
      start: 0,
      end: REPLY_COLLAPSED_COUNT
    })
  })
})

describe('getVisibleReplies', () => {
  it('折叠态取前几条, 展开态取当前页, 末页不足一页', () => {
    const target = root(1, 23)

    expect(visibleIds(target)).toEqual([1001, 1002, 1003])
    expect(visibleIds(target, { expanded: true, page: 2 })).toEqual([
      1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020
    ])
    expect(visibleIds(target, { expanded: true, page: 3 })).toEqual([
      1021, 1022, 1023
    ])
  })

  it('任意楼长与页码: 展开态的当前页不为空', () => {
    for (let replyCount = 4; replyCount <= 35; replyCount++) {
      const target = root(1, replyCount)
      for (const page of [1, 2, 3, 4, REPLY_LAST_PAGE]) {
        expect(
          visibleIds(target, { expanded: true, page }).length
        ).toBeGreaterThan(0)
      }
    }
  })

  it('正开着回复框的回复不在当前切片里也保持挂载, 且按原顺序排', () => {
    const target = root(1, 23)

    expect(
      getVisibleReplies(target.reply, { expanded: true, page: 2 }, 1005).map(
        (reply) => reply.id
      )
    ).toEqual([
      1005, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020
    ])
    expect(
      getVisibleReplies(target.reply, undefined, 1022).map((reply) => reply.id)
    ).toEqual([1001, 1002, 1003, 1022])
  })

  it('回复框所在的回复已在切片内, 或不属于本楼: 切片不变', () => {
    const target = root(1, 23)

    expect(
      getVisibleReplies(target.reply, undefined, 1002).map((reply) => reply.id)
    ).toEqual([1001, 1002, 1003])
    expect(
      getVisibleReplies(target.reply, undefined, 2005).map((reply) => reply.id)
    ).toEqual([1001, 1002, 1003])
    expect(
      getVisibleReplies(target.reply, undefined, null).map((reply) => reply.id)
    ).toEqual([1001, 1002, 1003])
  })

  it('折叠后不改动原数组', () => {
    const target = root(1, 5)

    getVisibleReplies(target.reply)

    expect(target.reply).toHaveLength(5)
  })
})

describe('locateReplyViews', () => {
  it('目标是根评论或不在本页: 不展开任何楼', () => {
    const comments = [root(1, 23), root(2, 0)]

    expect(locateReplyViews(comments, 2)).toEqual({})
    expect(locateReplyViews(comments, 99999)).toEqual({})
  })

  it('目标已在折叠预览内: 不展开', () => {
    expect(locateReplyViews([root(1, 23)], 1003)).toEqual({})
  })

  it('目标被折叠: 只展开它所在的楼, 并翻到它所在的回复页', () => {
    const comments = [root(1, 23), root(2, 23)]

    expect(locateReplyViews(comments, 2004)).toEqual({
      2: { expanded: true, page: 1 }
    })
    expect(locateReplyViews(comments, 2011)).toEqual({
      2: { expanded: true, page: 2 }
    })
    expect(locateReplyViews(comments, 1023)).toEqual({
      1: { expanded: true, page: 3 }
    })
  })

  it('任意楼长与位置: 定位出的视图必然露出目标回复', () => {
    for (let replyCount = 1; replyCount <= 35; replyCount++) {
      const target = root(1, replyCount)
      for (const reply of target.reply) {
        const views = locateReplyViews([target], reply.id)

        expect(visibleIds(target, views[target.id])).toContain(reply.id)
      }
    }
  })
})
