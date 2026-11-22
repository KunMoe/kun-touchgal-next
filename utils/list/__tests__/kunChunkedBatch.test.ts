import { describe, expect, it } from 'vitest'
import {
  kunDescribeBatchShortfall,
  kunMergeChunkResults,
  kunPlanChunks
} from '~/utils/list/kunChunkedBatch'

describe('分块批量', () => {
  it('按上限切块, 末块可以不满', () => {
    expect(kunPlanChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(kunPlanChunks([], 2)).toEqual([])
  })

  it('成功条数取服务端确认的数, 失败块整块保留供重试', () => {
    const chunks = kunPlanChunks([1, 2, 3, 4, 5], 2)
    expect(kunMergeChunkResults(chunks, [2, '权限不足', 1])).toEqual({
      succeeded: 3,
      failed: [3, 4],
      notRun: [],
      messages: ['权限不足']
    })
  })

  it('中途停止: 已发出的块照常计入, 其余记为没有执行 (P22-01)', () => {
    const chunks = kunPlanChunks([1, 2, 3, 4, 5], 2)
    expect(kunMergeChunkResults(chunks, [2])).toEqual({
      succeeded: 2,
      failed: [],
      notRun: [3, 4, 5],
      messages: []
    })
  })

  it('没有全部完成时的提示与旧文案一致, 停止时说明剩余条数', () => {
    expect(
      kunDescribeBatchShortfall(
        { succeeded: 3, failed: [4, 5], notRun: [], messages: [] },
        '删除'
      )
    ).toBe('已删除 3 条, 2 条删除失败, 已保留选中可重试')
    expect(
      kunDescribeBatchShortfall(
        { succeeded: 2, failed: [], notRun: [3, 4, 5], messages: [] },
        '删除'
      )
    ).toBe('已删除 2 条, 已停止, 剩余 3 条未删除, 已保留选中可重试')
  })
})
