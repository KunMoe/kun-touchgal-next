import crypto from 'crypto'
import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import {
  buildPatchBannerKeys,
  encodePatchBanner,
  putPatchBannerToS3
} from './_upload'
import { deleteFileFromS3 } from '~/lib/s3'
import {
  enqueueS3Deletion,
  kickS3DeletionDrain
} from '~/server/storage/s3Outbox'
import { patchCreateSchema } from '~/validations/edit'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { postToIndexNow } from './_postToIndexNow'
import { processSubmittedExternalData } from './processExternalData'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { queueSearchSync, enqueueSearchOutbox } from '~/server/search/sync'

// 事务回滚后的 banner 孤儿补偿: S3 上传发生在事务内, 回滚使对象失去 DB 引用, 而自增
// id 不随回滚回退、永不复用, patch/ 前缀又无 lifecycle 规则, 对象会永久滞留. 先查
// patch 行是否存在 —— 存在说明是 commit 响应丢失但实际已提交的极端情形, 此时不删
// (误删会砍掉活行的 banner); 不存在才即时删除, 删除失败的 key 落删除写出箱由 worker
// 兜底重试 (与 patch/resource/_helper.ts 的 bind 补偿同款). 全程 best-effort 吞错:
// 原始事务错误必须原样交回调用方分流, 孤儿残留是可接受的次级损失
const cleanupRolledBackBanner = async (patchId: number, keys: string[]) => {
  try {
    const committed = await prisma.patch.findUnique({
      where: { id: patchId },
      select: { id: true }
    })
    if (committed) {
      return
    }
    const failedKeys: string[] = []
    await Promise.all(
      keys.map((key) =>
        deleteFileFromS3(key).catch(() => {
          failedKeys.push(key)
        })
      )
    )
    if (failedKeys.length) {
      await enqueueS3Deletion(prisma, failedKeys)
      kickS3DeletionDrain()
    }
  } catch {
    // 补偿链自身的失败不上抛
  }
}

type CreateGalgameInput = Omit<
  z.infer<typeof patchCreateSchema>,
  'alias' | 'tag' | 'banner' | 'bannerOriginal'
> & {
  alias: string[]
  tag: string[]
  banner: ArrayBuffer
  bannerOriginal?: ArrayBuffer
}

export const createGalgame = async (input: CreateGalgameInput, uid: number) => {
  const {
    name,
    vndbId,
    vndbRelationId,
    bangumiId,
    steamId,
    dlsiteCode,
    dlsiteCircleName,
    dlsiteCircleLink,
    vndbTags,
    vndbDevelopers,
    bangumiTags,
    bangumiDevelopers,
    steamTags,
    steamDevelopers,
    steamAliases,
    alias,
    banner,
    bannerOriginal,
    tag,
    introduction,
    released,
    contentLimit
  } = input

  const galgameUniqueId = crypto.randomBytes(4).toString('hex')

  const normalizedVndbId = vndbId?.trim() ? vndbId.trim().toLowerCase() : ''
  const normalizedVndbRelationId = vndbRelationId?.trim()
    ? vndbRelationId.trim().toLowerCase()
    : ''
  const normalizedDlsiteCode = dlsiteCode?.trim()
    ? dlsiteCode.trim().toUpperCase()
    : ''
  const normalizedBangumiId = bangumiId ? Number(bangumiId) : null
  const normalizedSteamId = steamId ? Number(steamId) : null
  const [vndbPatch, dlsitePatch, bangumiPatch, steamPatch] = await Promise.all([
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
          select: { unique_id: true }
        })
      : null,
    normalizedDlsiteCode
      ? prisma.patch.findFirst({
          where: { dlsite_code: normalizedDlsiteCode },
          select: { unique_id: true }
        })
      : null,
    normalizedBangumiId !== null
      ? prisma.patch.findFirst({
          where: { bangumi_id: normalizedBangumiId },
          select: { unique_id: true }
        })
      : null,
    normalizedSteamId !== null
      ? prisma.patch.findFirst({
          where: { steam_id: normalizedSteamId },
          select: { unique_id: true }
        })
      : null
  ])

  if (vndbPatch) {
    if (normalizedVndbId && normalizedVndbRelationId) {
      return `Galgame VNDB ID 与 Relation ID 的组合与游戏 ID 为 ${vndbPatch.unique_id} 的游戏重复`
    }
    return normalizedVndbId
      ? `Galgame VNDB ID 与游戏 ID 为 ${vndbPatch.unique_id} 的游戏重复`
      : `Galgame VNDB Relation ID 与游戏 ID 为 ${vndbPatch.unique_id} 的游戏重复`
  }
  if (dlsitePatch) {
    return `Galgame DLSite Code 与游戏 ID 为 ${dlsitePatch.unique_id} 的游戏重复`
  }
  if (bangumiPatch) {
    return `Galgame Bangumi ID 与游戏 ID 为 ${bangumiPatch.unique_id} 的游戏重复`
  }
  if (steamPatch) {
    return `Galgame Steam ID 与游戏 ID 为 ${steamPatch.unique_id} 的游戏重复`
  }

  // 编码与校验必须在事务外完成: 它返回字符串表示业务错误, 若在事务回调内 return,
  // Prisma 会把回调正常结束当作提交, 留下一条 banner 为空、无别名/标签/搜索文档的
  // 孤儿 patch 行 (status 默认 0, 会直接出现在公开列表里)
  const encodedBanner = await encodePatchBanner(banner, bannerOriginal)
  if (typeof encodedBanner === 'string') {
    return encodedBanner
  }

  // keys 在上传前就赋值: putPatchBannerToS3 内部 Promise.all 部分成功后抛错时已有
  // 对象落盘, DeleteObject 幂等, 宁多删不漏删
  let uploadedBanner: { patchId: number; keys: string[] } | null = null

  const res = await prisma
    .$transaction(
      async (prisma) => {
        const patch = await prisma.patch.create({
          data: {
            name,
            unique_id: galgameUniqueId,
            vndb_id: normalizedVndbId ? normalizedVndbId : null,
            vndb_relation_id: normalizedVndbRelationId
              ? normalizedVndbRelationId
              : null,
            bangumi_id: normalizedBangumiId,
            steam_id: normalizedSteamId,
            dlsite_code: normalizedDlsiteCode ? normalizedDlsiteCode : null,
            introduction,
            user_id: uid,
            banner: '',
            released,
            content_limit: contentLimit
          }
        })

        const newId = patch.id

        uploadedBanner = {
          patchId: newId,
          keys: buildPatchBannerKeys(newId, Boolean(encodedBanner.fullBanner))
        }
        await putPatchBannerToS3(encodedBanner, newId)

        const imageLink = `${process.env.KUN_VISUAL_NOVEL_IMAGE_BED_URL}/patch/${newId}/banner/banner.avif`

        await prisma.patch.update({
          where: { id: newId },
          data: { banner: imageLink }
        })

        // Ensure rating_stat row exists for this patch
        await prisma.patch_rating_stat.create({
          data: { patch_id: newId }
        })

        if (alias.length) {
          const aliasData = alias.map((name) => ({
            name,
            patch_id: newId
          }))
          await prisma.patch_alias.createMany({
            data: aliasData,
            skipDuplicates: true
          })
        }

        await prisma.user.update({
          where: { id: uid },
          data: {
            daily_image_count: { increment: 1 },
            moemoepoint: { increment: 3 }
          }
        })

        // 事务性入队：与 patch.create 原子提交，关闭崩溃丢失窗口；tags 由后续
        // processSubmittedExternalData 独立事务写入，drain 读最新状态仍会纳入
        await enqueueSearchOutbox(prisma, newId)

        return { patchId: newId }
      },
      { timeout: 60000 }
    )
    .catch(async (error) => {
      // 事务已回滚 (或 commit 结果不确定), 补偿清理已上传的 banner 对象; P2002 发生在
      // patch.create, 早于上传, 彼时 uploadedBanner 仍为 null 不会触发清理
      if (uploadedBanner) {
        await cleanupRolledBackBanner(
          uploadedBanner.patchId,
          uploadedBanner.keys
        )
      }
      // bangumi_id / steam_id / dlsite_code / (vndb_id, vndb_relation_id) 组合及其
      // 单独形态部分唯一索引 (prisma/sql/patch_vndb_solo_unique.sql) 兜底并发创建:
      // 预检与 patch.create 之间隔着 encodePatchBanner, 实测可达十几秒,
      // 两个填同一外部 ID 的请求会双双通过预检. 字符串在此处返回是安全的(事务已回滚),
      // 但切勿把它挪进事务回调 —— 那会被当作正常结束而提交
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return '您填写的外部 ID 已经被其它 Galgame 使用, 请检查后重试'
      }
      throw error
    })

  if (typeof res === 'string') {
    return res
  }

  await invalidateUserSession(uid)

  await processSubmittedExternalData(
    res.patchId,
    {
      vndbTags,
      vndbDevelopers,
      bangumiTags,
      bangumiDevelopers,
      steamTags,
      steamDevelopers,
      steamAliases,
      dlsiteCircleName: dlsiteCircleName ?? '',
      dlsiteCircleLink: dlsiteCircleLink ?? ''
    },
    tag,
    uid
  )

  queueSearchSync(res.patchId)

  if (contentLimit === 'sfw') {
    const newPatchUrl = `${kunMoyuMoe.domain.main}/${galgameUniqueId}`
    void postToIndexNow(newPatchUrl).catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to post new patch to IndexNow', error)
    })
  }

  return { uniqueId: galgameUniqueId }
}
