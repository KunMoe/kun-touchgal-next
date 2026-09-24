import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { prisma } from '~/prisma/index'
import { getFavoriteFolderPatchSchema } from '~/validations/user'
import {
  GalgameCardSelectField,
  toGalgameCardCount
} from '~/constants/api/select'

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getFavoriteFolderPatchSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)

  const res = await getPatchByFolder(input, payload?.uid ?? 0)
  return NextResponse.json(res)
}

const getPatchByFolder = async (
  input: z.infer<typeof getFavoriteFolderPatchSchema>,
  uid?: number
) => {
  const folder = await prisma.user_patch_favorite_folder.findUnique({
    where: { id: input.folderId }
  })
  if (!folder) {
    return '未找到该文件夹'
  }
  if (!folder.is_public && folder.user_id !== uid) {
    return '您无权查看该私密文件夹'
  }

  const { page, limit } = input
  const offset = (page - 1) * limit
  const where = { folder_id: input.folderId }

  const [total, relations] = await Promise.all([
    prisma.user_patch_favorite_folder_relation.count({ where }),
    prisma.user_patch_favorite_folder_relation.findMany({
      where,
      include: {
        patch: {
          select: GalgameCardSelectField
        }
      },
      skip: offset,
      take: limit,
      orderBy: [{ created: 'desc' }, { id: 'asc' }]
    })
  ])

  const patches: GalgameCard[] = relations.map((relation) => ({
    id: relation.patch.id,
    uniqueId: relation.patch.unique_id,
    name: relation.patch.name,
    banner: relation.patch.banner,
    view: relation.patch.view,
    download: relation.patch.download,
    type: relation.patch.type,
    language: relation.patch.language,
    platform: relation.patch.platform,
    created: relation.patch.created,
    _count: toGalgameCardCount(relation.patch),
    averageRating: relation.patch.rating_stat?.avg_overall
      ? Math.round(relation.patch.rating_stat.avg_overall * 10) / 10
      : 0
  }))

  return { patches, total }
}
