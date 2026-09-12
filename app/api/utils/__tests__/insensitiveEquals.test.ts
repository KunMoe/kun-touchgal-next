import { describe, expect, it } from 'vitest'
import { insensitiveEquals } from '~/app/api/utils/insensitiveEquals'

describe('insensitiveEquals', () => {
  it('escapes LIKE wildcards and the escape character so they match literally', () => {
    expect(insensitiveEquals('a_c%\\d')).toEqual({
      equals: 'a\\_c\\%\\\\d',
      mode: 'insensitive'
    })
  })

  it('passes ordinary values through unchanged', () => {
    expect(insensitiveEquals('Tester@Example.com')).toEqual({
      equals: 'Tester@Example.com',
      mode: 'insensitive'
    })
  })
})
