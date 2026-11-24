import { afterEach, describe, expect, it, vi } from 'vitest'
import * as cacheConfig from '~/config/cache'
import {
  IMAGE_VERSION_DELETION_GRACE_MS,
  getUserAvatarKeys,
  getUserAvatarModerationArchiveKey,
  getUserAvatarPendingKeys,
  isPatchBannerPointerIn,
  isUserAvatarPendingKey,
  newContentImageKey,
  newPatchBannerSet,
  parsePatchBannerKey,
  patchBannerKeysFromPointer
} from '~/server/storage/imageObjects'

const BED = 'https://img.example.test'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

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

describe('newContentImageKey', () => {
  it('同一用户同一毫秒取两次, key 不同 (随机段由构造保证)', () => {
    vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', BED)
    vi.spyOn(Date, 'now').mockReturnValue(1_732_500_000_000)

    const a = newContentImageKey(7)
    const b = newContentImageKey(7)

    expect(a.key).not.toBe(b.key)
    expect(a.key).toMatch(/^user\/image\/7\/7-1732500000000-[0-9a-f]{8}\.avif$/)
    expect(a.url).toBe(`${BED}/${a.key}`)
  })
})

describe('isUserAvatarPendingKey', () => {
  it('只认本人 pending/ 目录下直接的 avif', () => {
    const { pendingKey, pendingMiniKey } = getUserAvatarPendingKeys(1, 'n')
    expect(isUserAvatarPendingKey(1, pendingKey)).toBe(true)
    expect(isUserAvatarPendingKey(1, pendingMiniKey)).toBe(true)
  })

  it('留档、正式头像、别人的暂存对象、子目录一律不认', () => {
    expect(
      isUserAvatarPendingKey(1, getUserAvatarModerationArchiveKey(1, 'n'))
    ).toBe(false)
    for (const key of Object.values(getUserAvatarKeys(1))) {
      expect(isUserAvatarPendingKey(1, key)).toBe(false)
    }
    expect(
      isUserAvatarPendingKey(1, getUserAvatarPendingKeys(10, 'n').pendingKey)
    ).toBe(false)
    expect(
      isUserAvatarPendingKey(1, 'user/avatar/user_1/pending/a/b.avif')
    ).toBe(false)
    expect(isUserAvatarPendingKey(1, '')).toBe(false)
  })
})

describe('patchBannerKeysFromPointer', () => {
  const UUID = '0f8c8a8e-3a3b-4c5d-9e6f-1a2b3c4d5e6f'

  it('存量形态: 推出固定目录下的三件套', () => {
    vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', BED)
    expect(
      patchBannerKeysFromPointer(1, `${BED}/patch/1/banner/banner.avif`)
    ).toEqual([
      'patch/1/banner/banner.avif',
      'patch/1/banner/banner-mini.avif',
      'patch/1/banner/banner-full.avif'
    ])
  })

  it('版本目录形态: 推出同一版本目录下的三件套', () => {
    vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', BED)
    expect(
      patchBannerKeysFromPointer(
        10,
        `${BED}/patch/10/banner/${UUID}/banner.avif`
      )
    ).toEqual([
      `patch/10/banner/${UUID}/banner.avif`,
      `patch/10/banner/${UUID}/banner-mini.avif`,
      `patch/10/banner/${UUID}/banner-full.avif`
    ])
  })

  // 认错的代价是删掉别人的对象: 下面这些一律不认
  it.each([
    [
      '别的游戏 (patch/1 不得匹配 patch/10)',
      1,
      `${BED}/patch/10/banner/banner.avif`
    ],
    [
      '别的游戏 (patch/10 不得匹配 patch/1)',
      10,
      `${BED}/patch/1/banner/banner.avif`
    ],
    ['外站主机', 1, 'https://evil.example.test/patch/1/banner/banner.avif'],
    ['前缀只是主机名的前缀', 1, `${BED}.evil.test/patch/1/banner/banner.avif`],
    [
      '外站地址把图床写在路径里',
      1,
      `https://evil.example.test/${BED}/patch/1/banner/banner.avif`
    ],
    ['.. 路径', 1, `${BED}/patch/1/banner/../../user/image/1/a.avif`],
    ['.. 当作版本段', 1, `${BED}/patch/1/banner/../banner.avif`],
    ['变体而不是主图', 1, `${BED}/patch/1/banner/banner-mini.avif`],
    ['资源对象', 1, `${BED}/patch/1/resource/abc/banner.avif`],
    ['版本段不是 uuid', 1, `${BED}/patch/1/banner/abc/banner.avif`],
    ['大写 uuid', 1, `${BED}/patch/1/banner/${UUID.toUpperCase()}/banner.avif`],
    ['带查询串', 1, `${BED}/patch/1/banner/banner.avif?v=1`],
    ['前导零的 id', 1, `${BED}/patch/01/banner/banner.avif`],
    ['空串', 1, '']
  ])('%s → []', (_label, patchId, pointer) => {
    vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', BED)
    expect(
      patchBannerKeysFromPointer(patchId as number, pointer as string)
    ).toEqual([])
  })

  it('没有配置图床前缀时一律不认', () => {
    vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', '')
    expect(
      patchBannerKeysFromPointer(1, '/patch/1/banner/banner.avif')
    ).toEqual([])
  })
})

describe('parsePatchBannerKey / isPatchBannerPointerIn', () => {
  const UUID = '0f8c8a8e-3a3b-4c5d-9e6f-1a2b3c4d5e6f'

  it('三种变体都归到同一个版本目录', () => {
    for (const name of ['banner', 'banner-mini', 'banner-full']) {
      expect(
        parsePatchBannerKey(`patch/12/banner/${UUID}/${name}.avif`)
      ).toEqual({ patchId: 12, dir: `patch/12/banner/${UUID}` })
      expect(parsePatchBannerKey(`patch/12/banner/${name}.avif`)).toEqual({
        patchId: 12,
        dir: 'patch/12/banner'
      })
    }
  })

  it('不是封面对象的 key 返回 null', () => {
    expect(parsePatchBannerKey('patch/12/resource/abc/banner.avif')).toBeNull()
    expect(parsePatchBannerKey('patch/12/banner/abc/banner.avif')).toBeNull()
    expect(parsePatchBannerKey('user/avatar/user_1/avatar.avif')).toBeNull()
    expect(parsePatchBannerKey('x/patch/12/banner/banner.avif')).toBeNull()
  })

  it('指针指向同一版本目录才算在用; 不看主机与查询串', () => {
    const versioned = `patch/12/banner/${UUID}`
    expect(
      isPatchBannerPointerIn(`${BED}/${versioned}/banner.avif`, versioned)
    ).toBe(true)
    expect(
      isPatchBannerPointerIn(
        `https://old.example.test/${versioned}/banner.avif?v=2`,
        versioned
      )
    ).toBe(true)
    // 换到版本目录之后, 固定目录的旧对象不再在用
    expect(
      isPatchBannerPointerIn(
        `${BED}/${versioned}/banner.avif`,
        'patch/12/banner'
      )
    ).toBe(false)
    expect(
      isPatchBannerPointerIn(`${BED}/patch/12/banner/banner.avif`, versioned)
    ).toBe(false)
    expect(
      isPatchBannerPointerIn(
        `${BED}/patch/112/banner/banner.avif`,
        'patch/12/banner'
      )
    ).toBe(false)
    expect(isPatchBannerPointerIn('', 'patch/12/banner')).toBe(false)
  })
})

describe('newPatchBannerSet', () => {
  it('每次一个新的随机版本目录, 指针是主图的公开地址, 解析回来就是这一组', () => {
    vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', BED)

    const a = newPatchBannerSet(12)
    const b = newPatchBannerSet(12)

    expect(a.keys.main).toMatch(
      /^patch\/12\/banner\/[0-9a-f-]{36}\/banner\.avif$/
    )
    expect(a.keys.main).not.toBe(b.keys.main)
    expect(a.pointer).toBe(`${BED}/${a.keys.main}`)
    expect(patchBannerKeysFromPointer(12, a.pointer)).toEqual(
      Object.values(a.keys)
    )
  })
})

// 换下来的封面版本要等共享读缓存里内嵌的旧地址全部过期才删。这里按 config/cache.ts 里全部 *_DURATION
// 核对 (秒): 有的缓存并不内嵌封面或头像地址, 宁严勿漏; 以后加了更长的、确实不内嵌图片地址的缓存,
// 在这里写明理由再排除
describe('IMAGE_VERSION_DELETION_GRACE_MS', () => {
  it('不短于任何一个缓存 TTL', () => {
    const durations = Object.entries(cacheConfig).filter(([name]) =>
      name.endsWith('_DURATION')
    )
    expect(durations.length).toBeGreaterThan(10)
    for (const [name, seconds] of durations) {
      expect(
        IMAGE_VERSION_DELETION_GRACE_MS,
        `${name} = ${seconds} 秒`
      ).toBeGreaterThanOrEqual((seconds as number) * 1000)
    }
  })
})
