'use server'

import * as z from 'zod'
import { cache } from 'react'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getTagById } from '~/app/api/tag/get'
import { getPatchByTag } from '~/app/api/tag/galgame/service'
import { getPatchVisibilityContext } from '~/utils/actions/getPatchVisibilityContext'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { getPatchByTagSchema, getTagByIdSchema } from '~/validations/tag'

const getCachedTagById = cache((tagId: number) => getTagById({ tagId }))

export const kunGetTagMetadataActions = async (
  params: z.infer<typeof getTagByIdSchema>
) => {
  const payload = await verifyHeaderCookie()
  if (!payload?.uid) {
    return null
  }

  const input = safeParseSchema(getTagByIdSchema, params)
  if (typeof input === 'string') {
    return input
  }

  return getCachedTagById(input.tagId)
}

export const kunGetTagPageDataActions = async (
  params: z.infer<typeof getPatchByTagSchema>
) => {
  const payload = await verifyHeaderCookie()
  if (!payload?.uid) {
    return null
  }

  const input = safeParseSchema(getPatchByTagSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const tagPromise = getCachedTagById(input.tagId)
  const responseResultPromise = getPatchVisibilityContext()
    .then((visibility) => getPatchByTag(input, visibility))
    .then(
      (response) => ({ status: 'fulfilled' as const, response }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    )
  const [tag, responseResult] = await Promise.all([
    tagPromise,
    responseResultPromise
  ])

  if (typeof tag === 'string') {
    return tag
  }
  if (responseResult.status === 'rejected') {
    throw responseResult.error
  }
  if (typeof responseResult.response === 'string') {
    return responseResult.response
  }

  return { tag, response: responseResult.response }
}
