import crypto from 'crypto'
import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunLog } from '~/lib/log.server'
import { kunTx } from '~/server/db/tx'
import { creditGalgamePublish } from '~/server/points/account'
import { encodePatchBanner } from './_upload'
import { putPatchBannerSet } from '~/server/storage/patchBanner'
import { newPatchBannerSet } from '~/server/storage/imageObjects'
import { deleteFileFromS3 } from '~/lib/s3'
import {
  enqueueS3Deletion,
  kickS3DeletionDrain
} from '~/server/storage/s3Outbox'
import { patchCreateSchema } from '~/validations/edit'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { postToIndexNow } from './_postToIndexNow'
import { processSubmittedExternalData } from './processExternalData'
import { normalizeGalgameExternalIds } from './_editFields'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import {
  enqueueSearchOutbox,
  kickSearchOutboxDrain
} from '~/server/search/sync'

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
    dlsiteCircleName,
    dlsiteCircleLink,
    vndbTags,
    vndbDevelopers,
    bangumiTags,
    bangumiDevelopers,
    steamTags,
    steamDevelopers,
    dlsiteTags,
    alias,
    banner,
    bannerOriginal,
    tag,
    introduction,
    released,
    contentLimit
  } = input

  const galgameUniqueId = crypto.randomBytes(4).toString('hex')

  const {
    vndbId: normalizedVndbId,
    vndbRelationId: normalizedVndbRelationId,
    bangumiId: normalizedBangumiId,
    steamId: normalizedSteamId,
    dlsiteCode: normalizedDlsiteCode
  } = normalizeGalgameExternalIds(input)
  const [vndbPatch, dlsitePatch, bangumiPatch, steamPatch] = await Promise.all([
    // 查询与即将写入的 (vndb_id, vndb_relation_id) 形态完全一致的行(空值按 null
    // 匹配): 单独 vndb_id / 单独 relation_id 也不允许重复, 但同 vndb_id 不同
    // relation 的共存不受影响. 并发兜底除组合唯一索引外还有两个 schema 无法声明的
    // 部分唯一索引, 见 db/migrations/0007_patch_vndb_solo_unique.notx.sql
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

  // 编码与校验在事务外完成: 编码可达十几秒, 不占着事务与连接
  const encodedBanner = await encodePatchBanner(banner, bannerOriginal)
  if (typeof encodedBanner === 'string') {
    return encodedBanner
  }

  // 事务里有 S3 上传, 不能开 retry: 重放后提交的话, 上一轮上传的对象没有人清理
  const res = await kunTx(
    'edit.create',
    async ({ tx: prisma, onRollback }) => {
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
      // 封面的第一个版本, 目录与指针取自 newPatchBannerSet (换封面时写的也是这种版本目录)
      const bannerSet = newPatchBannerSet(newId)

      // 没有提交 (或 commit 结果不确定) 时补偿清理已上传的 banner 对象。登记在上传之前:
      // putPatchBannerSet 部分成功后抛错时已有对象落盘; 三个 key 全删 (没写的 full 删了也成功),
      // 宁多删不漏删
      onRollback('banner', () =>
        cleanupRolledBackBanner(newId, Object.values(bannerSet.keys))
      )
      await putPatchBannerSet(encodedBanner, bannerSet)

      await prisma.patch.update({
        where: { id: newId },
        data: { banner: bannerSet.pointer }
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

      // 发布奖励与封面占用的当日图片计数是同一条 UPDATE
      await creditGalgamePublish(prisma, uid)

      // 事务性入队：与 patch.create 原子提交，关闭崩溃丢失窗口；tags 由后续
      // processSubmittedExternalData 另行写入，它写完之后自己再入队一次
      await enqueueSearchOutbox(prisma, newId)

      return { patchId: newId }
    },
    {
      timeout: 60000,
      // bangumi_id / steam_id / dlsite_code / (vndb_id, vndb_relation_id) 组合及其
      // 单独形态部分唯一索引 (db/migrations/0007_patch_vndb_solo_unique.notx.sql) 兜底并发创建:
      // 预检与 patch.create 之间隔着 encodePatchBanner, 实测可达十几秒,
      // 两个填同一外部 ID 的请求会双双通过预检. P2002 发生在 patch.create, 早于上传,
      // 彼时还没有登记 banner 的清理
      violations: {
        P2002: '您填写的外部 ID 已经被其它 Galgame 使用, 请检查后重试'
      }
    }
  )

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
      dlsiteTags,
      dlsiteCircleName: dlsiteCircleName ?? '',
      dlsiteCircleLink: dlsiteCircleLink ?? ''
    },
    // 新建的条目没有现存标签可移除, 手动标签全部是新增
    { removeTagIds: [], addTagNames: tag },
    uid
  )

  // 入库函数写完之后已自己入队 (建档事务里也入过一次), 这里只踢一次消费
  kickSearchOutboxDrain()

  if (contentLimit === 'sfw') {
    const newPatchUrl = `${kunMoyuMoe.domain.main}/${galgameUniqueId}`
    void postToIndexNow(newPatchUrl).catch((error) => {
      kunLog('external.request_failed', { source: 'indexnow' }, error)
    })
  }

  return { uniqueId: galgameUniqueId }
}
