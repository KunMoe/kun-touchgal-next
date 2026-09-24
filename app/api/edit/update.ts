import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { patchUpdateSchema } from '~/validations/edit'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { processSubmittedExternalData } from './processExternalData'
import { queueSearchSync, enqueueSearchOutbox } from '~/server/search/sync'
import { normalizeStringArray } from '~/utils/normalizeStringArray'

export const updateGalgame = async (
  input: z.infer<typeof patchUpdateSchema>,
  uid: number
) => {
  const normalizedVndbId = input.vndbId?.trim()
    ? input.vndbId.trim().toLowerCase()
    : ''
  const normalizedVndbRelationId = input.vndbRelationId?.trim()
    ? input.vndbRelationId.trim().toLowerCase()
    : ''
  const normalizedDlsiteCode = input.dlsiteCode?.trim()
    ? input.dlsiteCode.trim().toUpperCase()
    : ''
  const normalizedBangumiId = input.bangumiId ? Number(input.bangumiId) : null
  const normalizedSteamId = input.steamId ? Number(input.steamId) : null

  // 存在性检查与四条外部 ID 预检互不依赖, 并行发出 (与 create.ts 同形态); 并发
  // 兜底靠唯一索引 + 下方事务的 P2002 回退, 预检只负责给出可读的业务错误
  const [patch, vndbPatch, dlsitePatch, bangumiPatch, steamPatch] =
    await Promise.all([
      prisma.patch.findUnique({
        where: { id: input.id },
        select: { unique_id: true }
      }),
      // 查询与即将写入的 (vndb_id, vndb_relation_id) 形态完全一致的行(空值按 null
      // 匹配): 单独 vndb_id / 单独 relation_id 也不允许重复, 但同 vndb_id 不同
      // relation 的共存不受影响. 并发兜底除组合唯一索引外还有两个 schema 无法声明的
      // 部分唯一索引, 见 prisma/sql/patch_vndb_solo_unique.sql
      normalizedVndbId || normalizedVndbRelationId
        ? prisma.patch.findFirst({
            where: {
              vndb_id: normalizedVndbId ? normalizedVndbId : null,
              vndb_relation_id: normalizedVndbRelationId
                ? normalizedVndbRelationId
                : null
            },
            select: { id: true, unique_id: true }
          })
        : null,
      normalizedDlsiteCode
        ? prisma.patch.findFirst({
            where: { dlsite_code: normalizedDlsiteCode },
            select: { id: true, unique_id: true }
          })
        : null,
      normalizedBangumiId !== null
        ? prisma.patch.findFirst({
            where: { bangumi_id: normalizedBangumiId },
            select: { id: true, unique_id: true }
          })
        : null,
      normalizedSteamId !== null
        ? prisma.patch.findFirst({
            where: { steam_id: normalizedSteamId },
            select: { id: true, unique_id: true }
          })
        : null
    ])
  if (!patch) {
    return '该 ID 下未找到对应 Galgame'
  }
  // 占用方是自身时不算重复 (编辑不改外部 ID 的常态)
  if (vndbPatch && vndbPatch.id !== input.id) {
    if (normalizedVndbId && normalizedVndbRelationId) {
      return `Galgame VNDB ID 与 Relation ID 的组合与游戏 ID 为 ${vndbPatch.unique_id} 的游戏重复`
    }
    return normalizedVndbId
      ? `Galgame VNDB ID 与游戏 ID 为 ${vndbPatch.unique_id} 的游戏重复`
      : `Galgame VNDB Relation ID 与游戏 ID 为 ${vndbPatch.unique_id} 的游戏重复`
  }
  if (dlsitePatch && dlsitePatch.id !== input.id) {
    return `Galgame DLSite Code 与游戏 ID 为 ${dlsitePatch.unique_id} 的游戏重复`
  }
  if (bangumiPatch && bangumiPatch.id !== input.id) {
    return `Galgame Bangumi ID 与游戏 ID 为 ${bangumiPatch.unique_id} 的游戏重复`
  }
  if (steamPatch && steamPatch.id !== input.id) {
    return `Galgame Steam ID 与游戏 ID 为 ${steamPatch.unique_id} 的游戏重复`
  }

  const {
    id,
    dlsiteCircleName,
    dlsiteCircleLink,
    vndbTags,
    vndbDevelopers,
    bangumiTags,
    bangumiDevelopers,
    steamTags,
    steamDevelopers,
    steamAliases,
    name,
    alias,
    introduction,
    contentLimit,
    released
  } = input

  // 事务性入队：patch 字段更新与写出箱入队原子提交，关闭崩溃丢失窗口
  const updateResult = await prisma
    .$transaction(async (tx) => {
      await tx.patch.update({
        where: { id },
        data: {
          name,
          vndb_id: normalizedVndbId ? normalizedVndbId : null,
          vndb_relation_id: normalizedVndbRelationId
            ? normalizedVndbRelationId
            : null,
          bangumi_id: normalizedBangumiId,
          steam_id: normalizedSteamId,
          dlsite_code: normalizedDlsiteCode ? normalizedDlsiteCode : null,
          introduction,
          content_limit: contentLimit,
          released
        }
      })
      await enqueueSearchOutbox(tx, id)
    })
    .catch((error) => {
      // bangumi_id / steam_id / dlsite_code / (vndb_id, vndb_relation_id) 组合及其
      // 单独形态部分唯一索引 (prisma/sql/patch_vndb_solo_unique.sql) 兜底并发编辑:
      // 预检与 patch.update 之间两个填同一外部 ID 的请求会双双通过预检.
      // 字符串在此处返回是安全的(事务已回滚), 但切勿把它挪进事务回调 —— 那会被当作
      // 正常结束而提交
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return '您填写的外部 ID 已经被其它 Galgame 使用, 请检查后重试'
      }
      throw error
    })

  if (typeof updateResult === 'string') {
    return updateResult
  }

  await prisma.$transaction(async (prisma) => {
    await prisma.patch_alias.deleteMany({
      where: { patch_id: id }
    })

    // patch_alias 无 (patch_id, name) 唯一约束, skipDuplicates 挡不住批内重复,
    // 与 POST 路径(route.ts 的 checkStringArrayValid)对齐在应用层去重
    const aliasData = normalizeStringArray(alias).map((name) => ({
      name,
      patch_id: id
    }))

    await prisma.patch_alias.createMany({
      data: aliasData,
      skipDuplicates: true
    })
  })

  await processSubmittedExternalData(
    id,
    {
      vndbTags: vndbTags ?? [],
      vndbDevelopers: vndbDevelopers ?? [],
      bangumiTags: bangumiTags ?? [],
      bangumiDevelopers: bangumiDevelopers ?? [],
      steamTags: steamTags ?? [],
      steamDevelopers: steamDevelopers ?? [],
      steamAliases: steamAliases ?? [],
      dlsiteCircleName: dlsiteCircleName ?? '',
      dlsiteCircleLink: dlsiteCircleLink ?? ''
    },
    input.tag,
    uid
  )

  queueSearchSync(id)

  try {
    await invalidatePatchContentCache(patch.unique_id)
  } catch {
    // 缓存失效失败不影响编辑结果
  }

  return {}
}
