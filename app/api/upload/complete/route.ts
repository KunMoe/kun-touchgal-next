import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { KUN_BODY_BUDGET } from '~/constants/bodyBudget'
import {
  readUploadToken,
  verifyStagedObject
} from '~/server/storage/stagedUpload'
import { formatResourceSize } from '~/utils/resourceSize'

const completeSchema = z.object({
  token: z.string().min(8).max(128)
})

export const POST = kunRoute.post({
  auth: 'user',
  input: completeSchema,
  maxBytes: KUN_BODY_BUDGET.tiny,
  legacyDeny: { unauthenticated: '用户未认证' },
  handler: async ({ input, actor: payload }) => {
    const meta = await readUploadToken(input.token, payload.uid)
    if (typeof meta === 'string') {
      return meta
    }

    const verified = await verifyStagedObject(input.token, meta)
    if (typeof verified === 'string') {
      return verified
    }

    return {
      filetype: 's3',
      fileToken: input.token,
      fileSize: formatResourceSize(verified.size)
    }
  }
})
