import { aliasLookupFormsOf } from '~/utils/term/normalize'
import type { Prisma } from '~/prisma/generated/prisma/client'

// 读侧 (检索、联想、按名字筛选) 按别名比较的条件。大小写规则只随 aliasLookupForms, 不在
// 调用点各写 { has: q }。写侧的身份解析在 ./identity.ts

// 别名 (或会社的母品牌) 与输入之一相同
export const termAliasFilter = (inputs: string | readonly string[]) => ({
  hasSome: aliasLookupFormsOf(typeof inputs === 'string' ? [inputs] : inputs)
})

// 按名字筛选标签: 名字精确相同, 或别名相同
export const tagNameMatchWhere = (
  input: string
): Prisma.patch_tagWhereInput => ({
  OR: [{ name: input }, { alias: termAliasFilter(input) }]
})

// 按名字筛选会社: 另认母品牌。这是检索的召回语义, 写侧把名字解析到会社时不认母品牌
export const companyNameMatchWhere = (
  input: string
): Prisma.patch_companyWhereInput => ({
  OR: [
    { name: input },
    { alias: termAliasFilter(input) },
    { parent_brand: termAliasFilter(input) }
  ]
})
