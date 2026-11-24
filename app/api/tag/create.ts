import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { findTermConflict, tagTerms } from '~/server/term/identity'
import { createTagSchema } from '~/validations/tag'
import { invalidateTagListCache } from './cache'

export const createTag = async (
  input: z.infer<typeof createTagSchema>,
  uid: number
) => {
  const { name, introduction = '', alias = [] } = input

  const conflict = await findTermConflict(prisma, tagTerms, {
    name,
    addedAliases: alias
  })
  if (conflict) {
    return conflict
  }

  let newTag
  try {
    newTag = await prisma.patch_tag.create({
      data: {
        user_id: uid,
        name,
        introduction,
        alias
      },
      select: {
        id: true,
        name: true,
        count: true,
        alias: true
      }
    })
  } catch (error) {
    // name 唯一索引兜底并发创建: 上面的查重与 create 之间有窗口
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return '这个标签已经存在了'
    }
    throw error
  }
  await invalidateTagListCache()

  return newTag
}
