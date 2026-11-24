import { enqueueS3Deletion } from './s3Outbox'
import { patchBannerKeysFromPointer } from './imageObjects'
import type { Prisma } from '~/prisma/generated/prisma/client'

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
