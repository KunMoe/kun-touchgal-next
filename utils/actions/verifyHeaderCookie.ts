import 'server-only'

import { cache } from 'react'
import { loadAuthUser } from './loadAuthUser'

export const verifyHeaderCookie = cache(
  async () => (await loadAuthUser())?.payload ?? null
)
