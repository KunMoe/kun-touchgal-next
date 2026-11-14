import { describe, expect, it } from 'vitest'
import { removePatchNameFromAlias } from '~/utils/removePatchNameFromAlias'

describe('removePatchNameFromAlias', () => {
  it('剔除与游戏名相同的别名, 其余保持原顺序', () => {
    expect(removePatchNameFromAlias(['A', '游戏名', 'B'], '游戏名')).toEqual([
      'A',
      'B'
    ])
  })

  it('两侧 trim 后比较', () => {
    expect(removePatchNameFromAlias([' 游戏名 ', 'A'], '游戏名  ')).toEqual([
      'A'
    ])
  })

  it('只剔除完全相同项, 包含关系与大小写不同均保留', () => {
    expect(
      removePatchNameFromAlias(
        ['Game Name 2', 'game name', 'Game'],
        'Game Name'
      )
    ).toEqual(['Game Name 2', 'game name', 'Game'])
  })
})
