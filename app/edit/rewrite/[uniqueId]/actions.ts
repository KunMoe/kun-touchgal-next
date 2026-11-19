import 'server-only'

import * as z from 'zod'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getGalgameForRewrite } from '~/app/api/edit/rewriteData'

const uniqueIdSchema = z.object({
  uniqueId: z.string().regex(/^[A-Za-z0-9]{8}$/)
})

// 形状不对的 id 与查无此游戏同样回 null, 页面一律当作不存在
export const kunGetRewriteDataActions = async (uniqueId: string) => {
  const input = safeParseSchema(uniqueIdSchema, { uniqueId })
  if (typeof input === 'string') {
    return null
  }

  return getGalgameForRewrite(input.uniqueId)
}
