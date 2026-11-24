import { describe, expect, it } from 'vitest'
import {
  getUserAvatarKeys,
  getUserAvatarModerationArchiveKey,
  getUserAvatarPendingKeys
} from '~/server/storage/imageObjects'

describe('getUserAvatarKeys', () => {
  it('每用户固定, 只暴露正式发布 key, 不再含可变共享的暂存 key', () => {
    const keys = getUserAvatarKeys(42)
    expect(keys).toEqual({
      avatarKey: 'user/avatar/user_42/avatar.avif',
      avatarMiniKey: 'user/avatar/user_42/avatar-mini.avif'
    })
    // 正式 key 稳定: 同 uid 多次调用一致 (发布位置固定)
    expect(getUserAvatarKeys(42)).toEqual(keys)
    // 暂存 key 已从此处移除, 改由 getUserAvatarPendingKeys 每次上传唯一生成
    expect(keys).not.toHaveProperty('pendingKey')
    expect(keys).not.toHaveProperty('pendingMiniKey')
  })
})

describe('getUserAvatarPendingKeys', () => {
  it('把 nonce 编入路径, 暂存对象落在独立 pending/ 前缀下', () => {
    expect(getUserAvatarPendingKeys(42, 'nonce-abc')).toEqual({
      pendingKey: 'user/avatar/user_42/pending/nonce-abc.avif',
      pendingMiniKey: 'user/avatar/user_42/pending/nonce-abc-mini.avif'
    })
  })

  it('不同 nonce 产生不同 pending key —— 并发上传各写各的对象, 无从互相覆盖', () => {
    const a = getUserAvatarPendingKeys(42, 'nonce-a')
    const b = getUserAvatarPendingKeys(42, 'nonce-b')
    expect(a.pendingKey).not.toBe(b.pendingKey)
    expect(a.pendingMiniKey).not.toBe(b.pendingMiniKey)
  })

  it('暂存 key 与正式 key 不相交 —— apply 的复制目标永不等于复制源', () => {
    const finalKeys = new Set(Object.values(getUserAvatarKeys(42)))
    const pendingKeys = getUserAvatarPendingKeys(42, 'nonce-x')
    for (const key of Object.values(pendingKeys)) {
      expect(finalKeys.has(key)).toBe(false)
    }
  })
})

describe('getUserAvatarModerationArchiveKey', () => {
  it('把 nonce 编入路径, 留档对象落在独立 moderation/ 前缀下', () => {
    expect(getUserAvatarModerationArchiveKey(42, 'nonce-abc')).toBe(
      'user/avatar/user_42/moderation/nonce-abc.avif'
    )
  })

  it('避开 pending/ 前缀 —— 暂存对象的 S3 lifecycle 过期不会命中留档', () => {
    const archiveKey = getUserAvatarModerationArchiveKey(42, 'nonce-x')
    expect(archiveKey.includes('/pending/')).toBe(false)
  })

  it('与正式 key 和暂存 key 均不相交 —— 后续上传覆盖与裁决清理都不影响留档', () => {
    const otherKeys = new Set([
      ...Object.values(getUserAvatarKeys(42)),
      ...Object.values(getUserAvatarPendingKeys(42, 'nonce-x'))
    ])
    expect(
      otherKeys.has(getUserAvatarModerationArchiveKey(42, 'nonce-x'))
    ).toBe(false)
  })
})
