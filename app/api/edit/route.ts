import { NextResponse } from 'next/server'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { patchCreateSchema, patchUpdateSchema } from '~/validations/edit'
import { createGalgame } from './create'
import { updateGalgame } from './update'
import { normalizeStringArray } from '~/utils/normalizeStringArray'

const checkStringArrayValid = (type: 'alias' | 'tag', aliasString: string) => {
  const label = type === 'alias' ? '别名' : '标签'

  let parsedArray: unknown

  try {
    parsedArray = JSON.parse(aliasString)
  } catch {
    return `${label}格式不正确`
  }

  if (!Array.isArray(parsedArray)) {
    return `${label}格式不正确`
  }

  const normalizedArray = normalizeStringArray(parsedArray)

  if (normalizedArray.length > 100) {
    return `您最多使用 100 个${label}`
  }
  // patch_tag.name 是 VarChar(107) 而 patch_alias.name 是 VarChar(1007),
  // 标签超长若放行会在 patch 事务提交后的 batchTag 才抛 22001
  const limit = type === 'alias' ? 500 : 107
  const maxLength = normalizedArray.some((alias) => alias.length > limit)
  if (maxLength) {
    return `单个${label}的长度不可超过 ${limit} 个字符`
  }

  return normalizedArray
}

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'galgame.create',
  form: true,
  input: patchCreateSchema,
  handler: async ({ input, actor }) => {
    const { alias, banner, bannerOriginal, tag, ...rest } = input
    const aliasResult = checkStringArrayValid('alias', alias)
    if (typeof aliasResult === 'string') {
      return NextResponse.json(aliasResult)
    }
    const tagResult = checkStringArrayValid('tag', tag)
    if (typeof tagResult === 'string') {
      return NextResponse.json(tagResult)
    }
    const bannerArrayBuffer = await new Response(banner)?.arrayBuffer()
    const bannerOriginalArrayBuffer = bannerOriginal
      ? await new Response(bannerOriginal)?.arrayBuffer()
      : undefined

    const response = await createGalgame(
      {
        alias: aliasResult,
        tag: tagResult,
        banner: bannerArrayBuffer,
        bannerOriginal: bannerOriginalArrayBuffer,
        ...rest
      },
      actor.uid
    )
    return NextResponse.json(response)
  }
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'galgame.rewrite',
  input: patchUpdateSchema,
  handler: ({ input, actor }) => updateGalgame(input, actor.uid)
})
