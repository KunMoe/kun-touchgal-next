import { describe, expect, it } from 'vitest'
import { createTagSchema, updateTagSchema } from '~/validations/tag'
import { createCompanySchema } from '~/validations/company'

// 别名 (与会社的母品牌) 入库前就是规范形: 按别名比较的地方只按规范形查, 不靠录入端自觉
describe('标签 / 会社别名的入库形态', () => {
  it('标签别名去空白、转小写、去重', () => {
    const parsed = createTagSchema.parse({
      name: 'ADV',
      alias: [' AVG ', 'avg', 'Visual Novel']
    })
    expect(parsed.alias).toEqual(['avg', 'visual novel'])
    expect(updateTagSchema.parse({ tagId: 1, ...parsed }).alias).toEqual([
      'avg',
      'visual novel'
    ])
  })

  it('会社别名与母品牌同样规范化, 官网不动', () => {
    const parsed = createCompanySchema.parse({
      name: 'Key',
      primary_language: ['ja-jp'],
      alias: ['KEY', 'Key'],
      official_website: ['https://Key.example.com'],
      parent_brand: ['VisualArts']
    })
    expect(parsed.alias).toEqual(['key'])
    expect(parsed.parent_brand).toEqual(['visualarts'])
    expect(parsed.official_website).toEqual(['https://Key.example.com'])
  })

  it('空白别名与超长别名照旧被拒', () => {
    expect(
      createTagSchema.safeParse({ name: 'ADV', alias: ['  '] }).success
    ).toBe(false)
    expect(
      createTagSchema.safeParse({ name: 'ADV', alias: ['x'.repeat(18)] })
        .success
    ).toBe(false)
  })
})
