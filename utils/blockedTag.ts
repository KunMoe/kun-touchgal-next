import type { Prisma } from '~/prisma/generated/prisma/client'

// 每用户屏蔽标签数的上限, 在写路径 (addBlockedTag) 执法: 压住 NOT IN 的宽度与鉴权缓存里
// blocked_tag_ids 的体积 (每次鉴权都要反序列化)。400 覆盖现网最大值 (328); 这个数最初是按
// 客户端把列表写进单个 cookie 的 4096 字节推算的。服务端不接受客户端提供的屏蔽列表, 若将来
// 要把它放回客户端存储再读回来, int4 越界与基数的守卫须重新论证
export const MAX_BLOCKED_TAG_IDS = 400

export const appendBlockedTagId = (ids: number[], tagId: number) => {
  if (ids.includes(tagId)) {
    return ids
  }

  return [...ids, tagId]
}

export const removeBlockedTagId = (ids: number[], tagId: number) => {
  return ids.filter((id) => id !== tagId)
}

export const buildBlockedTagWhere = (
  blockedTagIds: readonly number[]
): Prisma.patchWhereInput => {
  if (!blockedTagIds.length) {
    return {}
  }

  return {
    NOT: {
      tag: {
        some: {
          tag_id: {
            in: [...blockedTagIds].sort((a, b) => a - b)
          }
        }
      }
    }
  }
}
