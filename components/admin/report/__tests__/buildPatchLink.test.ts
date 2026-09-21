import { describe, expect, it } from 'vitest'
import { buildPatchLink } from '~/components/admin/report/buildPatchLink'
import type { AdminReport } from '~/types/api/admin'

const user = (id: number): KunUser => ({ id, name: `u${id}`, avatar: '' })

// reportedUser 恒非空: 用于证明它不再进入链接 (旧实现会拼 &reportedUid=9,
// 该参数全站零消费者, 已随 target 一并清理)
const report = (overrides: Partial<AdminReport>): AdminReport => ({
  id: 1,
  targetType: 'comment',
  status: 0,
  reason: 'r',
  handlerReply: '',
  handledAt: null,
  created: '',
  sender: user(1),
  reportedUser: user(9),
  handler: null,
  patch: { id: 1, uniqueId: 'abcd1234', name: 'g' },
  comment: null,
  rating: null,
  ...overrides
})

describe('buildPatchLink', () => {
  it('资源评论深链到资源详情页', () => {
    const link = buildPatchLink(
      report({
        comment: { id: 5, contentPreview: 'c', resourceId: 12 }
      })
    )
    expect(link).toBe('/abcd1234/resource/12?commentId=5')
  })

  it('游戏评论深链到评论标签页', () => {
    const link = buildPatchLink(
      report({
        comment: { id: 5, contentPreview: 'c', resourceId: null }
      })
    )
    expect(link).toBe('/abcd1234?tab=comments&commentId=5')
  })

  it('评价举报深链到评价标签页', () => {
    const link = buildPatchLink(
      report({
        targetType: 'rating',
        rating: {
          id: 7,
          shortSummary: 's',
          overall: 8,
          recommend: 'recommend',
          playStatus: 'played'
        }
      })
    )
    expect(link).toBe('/abcd1234?tab=rating&ratingId=7')
  })

  it('被举报内容已删除时回落游戏详情页', () => {
    expect(buildPatchLink(report({ comment: null }))).toBe('/abcd1234')
  })

  it('缺少 uniqueId 时返回空串 (调用方据此置灰菜单项)', () => {
    expect(
      buildPatchLink(report({ patch: { id: 1, uniqueId: '', name: 'g' } }))
    ).toBe('')
  })
})
