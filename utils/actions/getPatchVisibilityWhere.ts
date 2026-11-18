import 'server-only'

import { cache } from 'react'
import { getNSFWHeader } from './getNSFWHeader'
import { getBlockedTagIds } from './getBlockedTagIds'
import { buildBlockedTagWhere } from '~/utils/blockedTag'
import type { Prisma } from '~/prisma/generated/prisma/client'

export const getPatchVisibilityWhere = cache(
  async (): Promise<Prisma.patchWhereInput> => {
    const [blockedTagIds, nsfwWhere] = await Promise.all([
      getBlockedTagIds(),
      getNSFWHeader()
    ])

    return {
      ...nsfwWhere,
      ...buildBlockedTagWhere(blockedTagIds)
    }
  }
)
