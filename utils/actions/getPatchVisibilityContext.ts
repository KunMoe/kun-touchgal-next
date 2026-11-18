import 'server-only'

import { cache } from 'react'
import { getNSFWHeader } from './getNSFWHeader'
import { getBlockedTagIds } from './getBlockedTagIds'
import { buildBlockedTagWhere } from '~/utils/blockedTag'
import type { PatchVisibilityContext } from '~/app/api/utils/getPatchVisibilityContext'

// Server Action 版本，与 app/api/utils/getPatchVisibilityContext 语义一致
export const getPatchVisibilityContext = cache(
  async (): Promise<PatchVisibilityContext> => {
    const [blockedTagIds, nsfwWhere] = await Promise.all([
      getBlockedTagIds(),
      getNSFWHeader()
    ])

    return {
      visibilityWhere: {
        ...nsfwWhere,
        ...buildBlockedTagWhere(blockedTagIds)
      },
      contentLimit: nsfwWhere.content_limit ?? null,
      blockedTagIds
    }
  }
)
