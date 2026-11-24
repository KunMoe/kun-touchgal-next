import { describe, expect, it } from 'vitest'
import {
  ADMIN_COMMENT_DELETE_LIMIT,
  ADMIN_RATING_DELETE_LIMIT,
  ADMIN_RESOURCE_DELETE_LIMIT
} from '~/constants/admin'
import {
  adminDeleteCommentSchema,
  adminDeleteRatingSchema,
  adminDeleteResourceSchema,
  adminUpdateResourceHiddenSchema
} from '~/validations/admin'

const buildIds = (count: number) =>
  Array.from({ length: count }, (_, i) => String(i + 1)).join(',')

describe('adminDeleteCommentSchema 批量删除上限', () => {
  it('前端分块大小 (整块 ADMIN_COMMENT_DELETE_LIMIT 条) 通过校验', () => {
    const result = adminDeleteCommentSchema.safeParse({
      commentIds: buildIds(ADMIN_COMMENT_DELETE_LIMIT)
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.commentIds).toHaveLength(ADMIN_COMMENT_DELETE_LIMIT)
    }
  })

  it('回归: 31 条 (旧上限 30 的越界点) 通过校验', () => {
    const result = adminDeleteCommentSchema.safeParse({
      commentIds: buildIds(31)
    })
    expect(result.success).toBe(true)
  })

  it('超过上限被拒绝', () => {
    const result = adminDeleteCommentSchema.safeParse({
      commentIds: buildIds(ADMIN_COMMENT_DELETE_LIMIT + 1)
    })
    expect(result.success).toBe(false)
  })

  it('单条 commentId 分支仍可用', () => {
    const result = adminDeleteCommentSchema.safeParse({ commentId: '7' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.commentIds).toEqual([7])
    }
  })
})

describe('adminDeleteRatingSchema 批量删除上限', () => {
  it('前端分块大小 (整块 ADMIN_RATING_DELETE_LIMIT 条) 通过校验', () => {
    const result = adminDeleteRatingSchema.safeParse({
      ratingIds: buildIds(ADMIN_RATING_DELETE_LIMIT)
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.ratingIds).toHaveLength(ADMIN_RATING_DELETE_LIMIT)
    }
  })

  it('回归: 31 条 (旧上限 30 的越界点) 通过校验', () => {
    const result = adminDeleteRatingSchema.safeParse({
      ratingIds: buildIds(31)
    })
    expect(result.success).toBe(true)
  })

  it('超过上限被拒绝', () => {
    const result = adminDeleteRatingSchema.safeParse({
      ratingIds: buildIds(ADMIN_RATING_DELETE_LIMIT + 1)
    })
    expect(result.success).toBe(false)
  })

  it('单条 ratingId 分支仍可用', () => {
    const result = adminDeleteRatingSchema.safeParse({ ratingId: '7' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.ratingIds).toEqual([7])
    }
  })
})

describe('adminDeleteResourceSchema 批量删除上限', () => {
  it('前端分块大小 (整块 ADMIN_RESOURCE_DELETE_LIMIT 条) 通过校验', () => {
    const result = adminDeleteResourceSchema.safeParse({
      resourceIds: buildIds(ADMIN_RESOURCE_DELETE_LIMIT)
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.resourceIds).toHaveLength(ADMIN_RESOURCE_DELETE_LIMIT)
    }
  })

  it('超过上限被拒绝', () => {
    const result = adminDeleteResourceSchema.safeParse({
      resourceIds: buildIds(ADMIN_RESOURCE_DELETE_LIMIT + 1)
    })
    expect(result.success).toBe(false)
  })

  it('单条 resourceId 分支仍可用', () => {
    const result = adminDeleteResourceSchema.safeParse({ resourceId: '7' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.resourceIds).toEqual([7])
    }
  })

  it('单条 resourceId 拒绝小数 (否则进 ::int[] 抛 22P02)', () => {
    expect(
      adminDeleteResourceSchema.safeParse({ resourceId: '1.5' }).success
    ).toBe(false)
  })

  it('重复 id 去重', () => {
    const result = adminDeleteResourceSchema.safeParse({
      resourceIds: '3, 1,3,2'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.resourceIds).toEqual([3, 1, 2])
    }
  })

  it('批量隐藏上限 (500) 不受删除上限影响', () => {
    const result = adminUpdateResourceHiddenSchema.safeParse({
      resourceIds: buildIds(500),
      status: 1
    })
    expect(result.success).toBe(true)
    expect(
      adminUpdateResourceHiddenSchema.safeParse({
        resourceIds: buildIds(501),
        status: 1
      }).success
    ).toBe(false)
  })
})

// 逗号串批量与单条用同一个上界 (int4 的类型边界, 见 validations/primitives.ts 的 kunId)
describe('批量删除的 id 上界与单条一致', () => {
  it.each([
    ['评论', adminDeleteCommentSchema, 'commentId', 'commentIds'],
    ['评价', adminDeleteRatingSchema, 'ratingId', 'ratingIds'],
    ['资源', adminDeleteResourceSchema, 'resourceId', 'resourceIds']
  ] as const)('%s', (_, schema, single, batch) => {
    expect(schema.safeParse({ [single]: '2147483647' }).success).toBe(true)
    expect(schema.safeParse({ [batch]: '10000000,2147483647' }).success).toBe(
      true
    )
    expect(schema.safeParse({ [single]: '2147483648' }).success).toBe(false)
    expect(schema.safeParse({ [batch]: '1,2147483648' }).success).toBe(false)
  })
})
