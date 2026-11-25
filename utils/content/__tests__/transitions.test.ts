import { describe, expect, it } from 'vitest'
import {
  COMMENT_TRANSITIONS,
  RATING_TRANSITIONS,
  RESOURCE_TRANSITIONS
} from '~/utils/content/transitions'

// 迁移表逐条钉住改用迁移表之前各写点手写的 from / to (编码: 评论 / 评价 0 公开 1 待审 2 隐藏,
// 资源 0 公开 1 隐藏 2 待初审 3 待审)。表里加一条、改一条, 这里都要跟着改: 改的是产品口径
describe('内容状态迁移表', () => {
  it('评论', () => {
    expect(COMMENT_TRANSITIONS).toEqual({
      // server/moderation/apply.ts 的裁决落定
      verdictApprove: { from: [1], to: 0 },
      verdictReject: { from: [1], to: 2 },
      // app/api/admin/comment/shadow-ban/shadowBan.ts: 除目标状态外的全部状态
      hide: { from: [0, 1], to: 2 },
      unhide: { from: [1, 2], to: 0 },
      // app/api/admin/appeal/handle.ts: 通过时恢复, 驳回时删除守卫
      appealApprove: { from: [2], to: 0 }
    })
  })

  it('评价与评论同一组迁移', () => {
    expect(RATING_TRANSITIONS).toEqual(COMMENT_TRANSITIONS)
  })

  it('资源', () => {
    expect(RESOURCE_TRANSITIONS).toEqual({
      verdictApprove: { from: [3], to: 0 },
      verdictReject: { from: [3], to: 1 },
      // app/api/admin/resource-apply/approve/route.ts
      approveFirst: { from: [2], to: 0 },
      // app/api/admin/resource/hidden/hidden.ts: 只在公开与隐藏之间
      hide: { from: [0], to: 1 },
      unhide: { from: [1], to: 0 },
      appealApprove: { from: [1], to: 0 }
    })
  })

  it('没有一条迁移以自己的终点为起点', () => {
    for (const table of [
      COMMENT_TRANSITIONS,
      RATING_TRANSITIONS,
      RESOURCE_TRANSITIONS
    ]) {
      for (const { from, to } of Object.values(table)) {
        expect(from as readonly number[]).not.toContain(to)
      }
    }
  })
})
