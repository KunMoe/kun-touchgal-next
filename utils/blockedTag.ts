import type { Prisma } from '~/prisma/generated/prisma/client'

// 每用户屏蔽标签数的唯一上限: 写路径 (addBlockedTag) 与镜像 cookie 解析共用,
// 两处同值才不会出现「cookie 截断到上限、DB 回落却是全量」的可见性分叉。同时
// 压住 NOT IN 的宽度与鉴权缓存里 blocked_tag_ids 的体积 (每次鉴权都要反序列化)。
// 400 的来头是浏览器单 cookie 4096 字节: 镜像 cookie 名占 50 字节, js-cookie 把
// 逗号编码成 %2C, 400 个 5 位 id 约 3.2KB 仍有余量 —— 超限时浏览器静默拒写、旧值
// 残留, 新屏蔽将永不生效。400 亦覆盖现网最大值 (328)
export const MAX_BLOCKED_TAG_IDS = 400

// tag_id 是 int4, 越界值不会被 Prisma 拦下, 到 Postgres 抛 P2020 冒泡成 500
// (同类先例见 validations/edit.ts 的 bangumi_id / steam_id)
const INT4_MAX = 2147483647

// null = 镜像 cookie 不可用 (畸形转义 / 坏 JSON / 非数组), 调用方须回落 DB,
// 与 next/headers 对畸形值的丢弃语义对齐; 回落 [] 会把 DB 里的屏蔽列表短路掉。
// 空数组是合法缓存值 (用户未屏蔽任何标签), 不能与坏缓存混为一谈
export const parseBlockedTagIds = (value?: string | null) => {
  if (!value) {
    return null
  }

  try {
    const data = JSON.parse(value)
    if (!Array.isArray(data)) {
      return null
    }

    // 去重必须在 Number 归一化之后, 否则 "1" / "01" / "1.0" 互不相等全部存活,
    // 重复项会进缓存键并挤占 MAX_BLOCKED_TAG_IDS 配额
    return [
      ...new Set(
        data
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0 && id <= INT4_MAX)
      )
    ].slice(0, MAX_BLOCKED_TAG_IDS)
  } catch {
    return null
  }
}

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
  blockedTagIds: number[]
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
