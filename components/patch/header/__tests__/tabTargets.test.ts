import { describe, expect, it } from 'vitest'
import {
  mergePatchTabTargets,
  readPatchTabTargets
} from '~/components/patch/header/tabTargets'

const params = (query: string) => new URLSearchParams(query)

const EMPTY = {
  commentId: null,
  ratingId: null,
  resourceId: null,
  resourceSection: null
}

describe('readPatchTabTargets', () => {
  it('解析四个深链参数', () => {
    expect(
      readPatchTabTargets(
        params(
          'tab=resources&commentId=1&ratingId=2&resourceId=3&resourceSection=patch'
        )
      )
    ).toEqual({
      commentId: 1,
      ratingId: 2,
      resourceId: 3,
      resourceSection: 'patch'
    })
  })

  it('非正安全整数与未知分区视为缺省', () => {
    expect(
      readPatchTabTargets(
        params('commentId=0&ratingId=abc&resourceId=1e400&resourceSection=x')
      )
    ).toEqual(EMPTY)
  })
})

// 保活的隐藏面板拿到的目标一旦变成 null, 评论会在隐藏时重拉重挂载 (测高为 0 丢展开
// 按钮), 评价会被整体重置. 切 tab 剥掉参数时目标必须保持不变, 且返回原对象以免
// 触发多余渲染
describe('mergePatchTabTargets', () => {
  const landed = readPatchTabTargets(
    params('tab=comments&commentId=28983&ratingId=5')
  )

  it('剥掉深链参数时保留原目标并返回同一对象', () => {
    expect(mergePatchTabTargets(landed, params('tab=resources'))).toBe(landed)
  })

  it('新的深链替换对应目标', () => {
    expect(
      mergePatchTabTargets(landed, params('tab=comments&commentId=7'))
    ).toEqual({ ...landed, commentId: 7 })
  })

  it('资源分区与 id 成组替换, 不混用旧分区', () => {
    const current = readPatchTabTargets(
      params('tab=resources&resourceSection=patch&resourceId=3')
    )
    expect(
      mergePatchTabTargets(current, params('tab=resources&resourceId=9'))
    ).toEqual({ ...current, resourceId: 9, resourceSection: null })
    expect(mergePatchTabTargets(current, params('tab=comments'))).toBe(current)
  })
})
