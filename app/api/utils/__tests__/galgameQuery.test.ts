import { describe, expect, it } from 'vitest'
import { buildGalgameOrderBy } from '~/app/api/utils/galgameQuery'
import type { SortField } from '~/components/galgame/_sort'

const SORT_FIELDS: SortField[] = [
  'resource_update_time',
  'created',
  'view',
  'download',
  'favorite',
  'rating'
]

describe('buildGalgameOrderBy', () => {
  it.each(SORT_FIELDS)('%s 排序末位恒为 id 降序 tiebreaker', (sortField) => {
    for (const sortOrder of ['asc', 'desc'] as const) {
      const orderBy = buildGalgameOrderBy(sortField, sortOrder)
      expect(orderBy).toHaveLength(2)
      expect(orderBy[1]).toEqual({ id: 'desc' })
    }
  })

  it('主排序键保持各字段的映射', () => {
    expect(buildGalgameOrderBy('favorite', 'asc')[0]).toEqual({
      favorite_count: 'asc'
    })
    expect(buildGalgameOrderBy('rating', 'desc')[0]).toEqual({
      rating_stat: { avg_overall: 'desc' }
    })
    expect(buildGalgameOrderBy('view', 'desc')[0]).toEqual({ view: 'desc' })
  })

})
