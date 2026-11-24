import { prisma } from '~/prisma/index'
import { uploadImageToS3 } from '~/lib/s3'
import { kunTx } from '~/server/db/tx'
import { recordKunChanges } from '~/server/cache/publish'
import {
  enqueueSearchOutbox,
  kickSearchOutboxDrain
} from '~/server/search/sync'
import { purgeCloudflareCache } from '~/app/api/utils/purgeCloudflareCache'
import { enqueueS3Deletion, kickS3DeletionDrain } from './s3Outbox'
import {
  IMAGE_VERSION_DELETION_GRACE_MS,
  newPatchBannerSet,
  patchBannerKeysFromPointer
} from './imageObjects'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { PatchBannerSet } from './imageObjects'

// 封面的「当前版本」只由 patch.banner 指针裁决。一个版本是 server/storage/imageObjects.ts 给出的
// 一个随机目录, 写进去之后不再改; 换封面 = 写一组新对象 → patch 行锁下换指针 → 旧的一组延迟入删除
// 写出箱。地址每次都是新的, 不再靠 Cloudflare purge 与浏览器强刷让新图生效

export interface EncodedPatchBanner {
  banner: Buffer
  miniBanner: Buffer
  fullBanner?: Buffer
}

// 写一个版本的对象, 失败直接抛出。等全部写完 (成功或失败) 才返回: 一个失败就立刻抛的话, 其余还在
// 路上的写入可能落在调用方的清理之后, 留下没人回收的对象
export const putPatchBannerSet = async (
  encoded: EncodedPatchBanner,
  set: PatchBannerSet
) => {
  const results = await Promise.allSettled([
    uploadImageToS3(set.keys.main, encoded.banner),
    uploadImageToS3(set.keys.mini, encoded.miniBanner),
    ...(encoded.fullBanner
      ? [uploadImageToS3(set.keys.full, encoded.fullBanner)]
      : [])
  ])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }
}

// 封面版本的回收入队, 删游戏与换封面共用这一个函数: 按指针 (patch.banner) 推出那个版本目录下的
// 全部对象, 在调用方的事务里入删除写出箱, 与指针的改写或行的删除一起提交。delayMs 是宽限期 (换封面时
// 旧版本还被缓存里的页面引用), 不传即立即 (删游戏)。指针认不出 (外站地址、换过域名的存量) 时不入队,
// 只记一行: 留下孤儿, 不冒删错的险
export const enqueuePatchBannerDeletion = async (
  client: Prisma.TransactionClient,
  patchId: number,
  pointer: string,
  options: { delayMs?: number } = {}
) => {
  const keys = patchBannerKeysFromPointer(patchId, pointer)
  if (!keys.length) {
    if (pointer) {
      // eslint-disable-next-line no-console
      console.warn(
        `封面指针不在配置的图床下或形态不符, 不回收: patch ${patchId} ${pointer}`
      )
    }
    return
  }
  await enqueueS3Deletion(client, keys, options)
}

// 没换上去的新版本立即回收。经出箱而不是直接删: drain 删之前还会按指针再判一次在不在用
const recycleSet = async (set: PatchBannerSet) => {
  await enqueueS3Deletion(prisma, Object.values(set.keys))
  kickS3DeletionDrain()
}

// discardOld: 换封面是为了撤下违规图片时, 旧版本不留宽限期、立即删, 并清掉 CDN 上的旧地址。代价是
// 缓存里还拿着旧地址的页面 (最多几分钟) 显示裂图
export const replacePatchBanner = async (
  patchId: number,
  encoded: EncodedPatchBanner,
  options: { discardOld?: boolean } = {}
): Promise<{ banner: string } | string> => {
  const set = newPatchBannerSet(patchId)

  // 新版本写在事务之外, 上传的几秒里不占着 patch 行锁
  try {
    await putPatchBannerSet(encoded, set)
  } catch (error) {
    await recycleSet(set).catch((cleanupError) =>
      // eslint-disable-next-line no-console
      console.error('封面新版本写入失败后的回收入队失败:', cleanupError)
    )
    throw error
  }

  return kunTx(
    'patch.banner.replace',
    async (ctx) => {
      const { tx } = ctx
      // 只取这一把 patch 行锁, 与删游戏 (先锁资源行、再删 patch 行) 不成环。删游戏先拿到锁的话这里读
      // 不到行, 新版本由 onRollback 回收; 这里先拿到的话, 删游戏的 RETURNING 读到的就是新指针
      const [patch] = await tx.$queryRaw<
        Array<{ banner: string; unique_id: string }>
      >`SELECT banner, unique_id FROM patch WHERE id = ${patchId} FOR UPDATE`
      if (!patch) {
        ctx.fail('这个 Galgame 不存在')
      }

      await tx.patch.update({
        where: { id: patchId },
        data: { banner: set.pointer }
      })
      await enqueueSearchOutbox(tx, patchId)
      await enqueuePatchBannerDeletion(
        tx,
        patchId,
        patch.banner,
        options.discardOld ? {} : { delayMs: IMAGE_VERSION_DELETION_GRACE_MS }
      )
      recordKunChanges(ctx, [
        { kind: 'patch', patchId, uniqueId: patch.unique_id }
      ])
      ctx.afterCommit('searchKick', () => kickSearchOutboxDrain())
      if (options.discardOld) {
        ctx.afterCommit('s3Kick', () => kickS3DeletionDrain())
        const oldUrls = patchBannerKeysFromPointer(patchId, patch.banner).map(
          (key) => `${process.env.KUN_VISUAL_NOVEL_IMAGE_BED_URL}/${key}`
        )
        if (oldUrls.length) {
          ctx.afterCommit('purgeOld', () => purgeCloudflareCache(oldUrls))
        }
      }
      return { banner: set.pointer }
    },
    {
      // 没有提交: 回收新版本。commit 抛错时结果不确定, 指针若已经是新版本就说明其实提交了, 不回收
      // (drain 删之前还会再按指针判一次)
      onRollback: async () => {
        const current = await prisma.patch.findUnique({
          where: { id: patchId },
          select: { banner: true }
        })
        if (current?.banner !== set.pointer) {
          await recycleSet(set)
        }
      }
    }
  )
}
