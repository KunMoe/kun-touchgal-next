import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 换封面: 新版本写在事务外 → patch 行锁下换指针 → 旧版本带宽限期入删除写出箱。语句顺序与提交 /
// 回滚由录制型 prisma 假对象记下; 出箱与 SQL 语义 (not_before、引用判定) 在 s3Outbox.db.test.ts
// 的真库上测

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)

const mocks = vi.hoisted(() => ({
  uploadImageToS3: vi.fn(),
  deleteFileFromS3: vi.fn(),
  isS3ObjectReferenced: vi.fn(),
  enqueueS3Deletion: vi.fn(),
  kickS3DeletionDrain: vi.fn(),
  enqueueSearchOutbox: vi.fn(),
  kickSearchOutboxDrain: vi.fn(),
  recordKunChanges: vi.fn(),
  purgeCloudflareCache: vi.fn()
}))

vi.mock('~/prisma/index', () => rec.module)
vi.mock('~/lib/s3', () => ({
  uploadImageToS3: mocks.uploadImageToS3,
  deleteFileFromS3: mocks.deleteFileFromS3
}))
vi.mock('~/server/storage/references', () => ({
  isS3ObjectReferenced: mocks.isS3ObjectReferenced
}))
vi.mock('~/server/storage/s3Outbox', () => ({
  enqueueS3Deletion: mocks.enqueueS3Deletion,
  kickS3DeletionDrain: mocks.kickS3DeletionDrain
}))
vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: mocks.enqueueSearchOutbox,
  kickSearchOutboxDrain: mocks.kickSearchOutboxDrain
}))
vi.mock('~/server/cache/publish', () => ({
  recordKunChanges: mocks.recordKunChanges
}))
vi.mock('~/app/api/utils/purgeCloudflareCache', () => ({
  purgeCloudflareCache: mocks.purgeCloudflareCache
}))

import {
  putPatchBannerSet,
  replacePatchBanner
} from '~/server/storage/patchBanner'
import {
  IMAGE_VERSION_DELETION_GRACE_MS,
  newPatchBannerSet
} from '~/server/storage/imageObjects'

const BED = 'https://img.example.test'
const PATCH_ID = 42
const OLD_VERSION = `patch/${PATCH_ID}/banner/0f8c8a8e-3a3b-4c5d-9e6f-1a2b3c4d5e6f`
const OLD_POINTER = `${BED}/${OLD_VERSION}/banner.avif`
const OLD_KEYS = [
  `${OLD_VERSION}/banner.avif`,
  `${OLD_VERSION}/banner-mini.avif`,
  `${OLD_VERSION}/banner-full.avif`
]
const VERSION_POINTER = new RegExp(
  `^${BED}/patch/${PATCH_ID}/banner/[0-9a-f-]{36}/banner\\.avif$`
)

const encoded = {
  banner: Buffer.from('main'),
  miniBanner: Buffer.from('mini')
}

const LOCK =
  /SELECT banner, unique_id FROM patch WHERE id = \? FOR NO KEY UPDATE/

// 事务外写入的那组 key (从实际 PUT 的主图 key 推出)
const newKeys = () => {
  const [mainKey] = mocks.uploadImageToS3.mock.calls[0] as [string]
  const dir = mainKey.replace(/\/banner\.avif$/, '')
  return [
    `${dir}/banner.avif`,
    `${dir}/banner-mini.avif`,
    `${dir}/banner-full.avif`
  ]
}
const callsWith = (keys: string[]) =>
  mocks.enqueueS3Deletion.mock.calls.filter(
    ([, enqueued]) => JSON.stringify(enqueued) === JSON.stringify(keys)
  )

let events: string[]

// 入队函数是 mock: 让它在收到的 client 上记一条语句, 用的是事务 tx 的话这条语句落在那次尝试里,
// 用的是事务外的 prisma 就落在 rec.outside 里
const markOn =
  (name: string) =>
  async (client: { $executeRaw: (strings: string[]) => unknown }) => {
    await client.$executeRaw([`-- ${name}`])
  }

beforeEach(() => {
  vi.resetAllMocks()
  rec.reset()
  events = []
  vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', BED)
  mocks.uploadImageToS3.mockImplementation(async (key: string) => {
    events.push(`put:${key.split('/').at(-1)}`)
  })
  rec.onRaw(LOCK, () => {
    events.push('lock')
    return [{ banner: OLD_POINTER, unique_id: 'u42' }]
  })
  rec.on('patch.findUnique', { banner: OLD_POINTER })
  mocks.enqueueS3Deletion.mockImplementation(markOn('enqueueS3Deletion'))
  mocks.enqueueSearchOutbox.mockImplementation(markOn('enqueueSearchOutbox'))
  mocks.isS3ObjectReferenced.mockResolvedValue(false)
  mocks.deleteFileFromS3.mockImplementation(async (key: string) => {
    events.push(`delete:${key}`)
  })
  mocks.purgeCloudflareCache.mockImplementation(async () => {
    events.push('purge')
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('putPatchBannerSet', () => {
  it('写主图与小图, 有原图才写 full', async () => {
    const set = newPatchBannerSet(PATCH_ID)

    await putPatchBannerSet(encoded, set)
    await putPatchBannerSet({ ...encoded, fullBanner: Buffer.from('f') }, set)

    expect(mocks.uploadImageToS3.mock.calls.map(([key]) => key)).toEqual([
      set.keys.main,
      set.keys.mini,
      set.keys.main,
      set.keys.mini,
      set.keys.full
    ])
  })

  // 一个失败就立刻抛的话, 还在路上的写入会落在调用方的回收之后
  it('有一个失败时等其余写入结束才抛', async () => {
    let finishSlow!: () => void
    mocks.uploadImageToS3
      .mockImplementationOnce(() => Promise.reject(new Error('S3 down')))
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishSlow = resolve))
      )

    let settled = false
    const put = putPatchBannerSet(encoded, newPatchBannerSet(PATCH_ID)).finally(
      () => (settled = true)
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    finishSlow()
    await expect(put).rejects.toThrow('S3 down')
  })
})

describe('replacePatchBanner', () => {
  it('先写新版本, 再在 patch 行锁下换指针; 旧版本带宽限期入队, 入搜索出箱, 报告详情变更', async () => {
    const res = await replacePatchBanner(PATCH_ID, encoded)

    expect(res).toEqual({ banner: expect.stringMatching(VERSION_POINTER) })
    const pointer = (res as { banner: string }).banner
    expect(events).toEqual(['put:banner.avif', 'put:banner-mini.avif', 'lock'])

    const [attempt] = rec.attempts
    expect(attempt.committed).toBe(true)
    // 两次入队都在事务里 (用的是 tx), 与换指针一起提交
    expect(attempt.statements.map((s) => s.label)).toEqual([
      expect.stringMatching(LOCK),
      'patch.update',
      '$executeRaw: -- enqueueSearchOutbox',
      '$executeRaw: -- enqueueS3Deletion'
    ])
    expect(rec.argsOf('patch.update')).toEqual([
      { where: { id: PATCH_ID }, data: { banner: pointer } }
    ])
    expect(newKeys()[0]).toBe(pointer.slice(BED.length + 1))

    expect(mocks.enqueueS3Deletion).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueS3Deletion).toHaveBeenCalledWith(
      expect.anything(),
      OLD_KEYS,
      { delayMs: IMAGE_VERSION_DELETION_GRACE_MS }
    )
    expect(mocks.enqueueSearchOutbox).toHaveBeenCalledWith(
      expect.anything(),
      PATCH_ID
    )
    expect(mocks.recordKunChanges).toHaveBeenCalledWith(expect.anything(), [
      { kind: 'patch', patchId: PATCH_ID, uniqueId: 'u42' }
    ])
    expect(mocks.kickSearchOutboxDrain).toHaveBeenCalledTimes(1)
    // 地址每次都是新的: 不再清 CDN, 旧版本留到宽限期过后才删
    expect(mocks.purgeCloudflareCache).not.toHaveBeenCalled()
    expect(mocks.deleteFileFromS3).not.toHaveBeenCalled()
    expect(mocks.kickS3DeletionDrain).not.toHaveBeenCalled()
  })

  it('存量的固定目录指针: 换下来的是固定目录的三件套', async () => {
    rec.onRaw(LOCK, [
      {
        banner: `${BED}/patch/${PATCH_ID}/banner/banner.avif`,
        unique_id: 'u42'
      }
    ])

    await replacePatchBanner(PATCH_ID, encoded)

    expect(mocks.enqueueS3Deletion).toHaveBeenCalledWith(
      expect.anything(),
      [
        `patch/${PATCH_ID}/banner/banner.avif`,
        `patch/${PATCH_ID}/banner/banner-mini.avif`,
        `patch/${PATCH_ID}/banner/banner-full.avif`
      ],
      { delayMs: IMAGE_VERSION_DELETION_GRACE_MS }
    )
  })

  it('discardOld: 旧版本在事务里立即入队; 提交后先删源对象、再清 CDN', async () => {
    await replacePatchBanner(PATCH_ID, encoded, { discardOld: true })

    expect(mocks.enqueueS3Deletion).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueS3Deletion).toHaveBeenCalledWith(
      expect.anything(),
      OLD_KEYS
    )
    expect(rec.attempts[0].statements.map((s) => s.label)).toContain(
      '$executeRaw: -- enqueueS3Deletion'
    )
    // 反过来的话, 清完到删掉之间回源的请求会把旧图重新缓存到边缘
    expect(events.slice(-4)).toEqual([
      ...OLD_KEYS.map((key) => `delete:${key}`),
      'purge'
    ])
    expect(mocks.purgeCloudflareCache).toHaveBeenCalledWith(
      OLD_KEYS.map((key) => `${BED}/${key}`)
    )
  })

  // 改成版本目录之前, 换封面每次都覆盖本游戏的固定目录, 撤图对换过域名的存量照旧生效
  it('discardOld 而旧指针不在配置的图床下: 退回本游戏固定目录的三件套', async () => {
    rec.onRaw(LOCK, [
      {
        banner: `https://old-domain.example.test/patch/${PATCH_ID}/banner/banner.avif`,
        unique_id: 'u42'
      }
    ])
    const legacyKeys = [
      `patch/${PATCH_ID}/banner/banner.avif`,
      `patch/${PATCH_ID}/banner/banner-mini.avif`,
      `patch/${PATCH_ID}/banner/banner-full.avif`
    ]

    await replacePatchBanner(PATCH_ID, encoded, { discardOld: true })

    expect(mocks.enqueueS3Deletion).toHaveBeenCalledWith(
      expect.anything(),
      legacyKeys
    )
    expect(mocks.deleteFileFromS3.mock.calls.map(([key]) => key)).toEqual(
      legacyKeys
    )
    expect(mocks.purgeCloudflareCache).toHaveBeenCalledWith(
      legacyKeys.map((key) => `${BED}/${key}`)
    )
  })

  it('discardOld: 仍被引用的不删; 删失败的留给出箱, CDN 照样清', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.isS3ObjectReferenced.mockImplementation(
      async (_db: unknown, key: string) => key === OLD_KEYS[0]
    )
    mocks.deleteFileFromS3.mockImplementation(async (key: string) => {
      if (key === OLD_KEYS[1]) {
        throw new Error('S3 flaky')
      }
      events.push(`delete:${key}`)
    })

    await replacePatchBanner(PATCH_ID, encoded, { discardOld: true })

    expect(mocks.deleteFileFromS3.mock.calls.map(([key]) => key)).toEqual(
      OLD_KEYS.slice(1)
    )
    expect(events.slice(-2)).toEqual([`delete:${OLD_KEYS[2]}`, 'purge'])
  })

  it('行锁下读不到行 (被并发删掉): 回不存在, 不提交, 回收新版本', async () => {
    rec.onRaw(LOCK, [])
    rec.on('patch.findUnique', null)

    expect(await replacePatchBanner(PATCH_ID, encoded)).toBe(
      '这个 Galgame 不存在'
    )

    const [attempt] = rec.attempts
    expect(attempt.rolledBack).toBe(true)
    expect(attempt.statements.map((s) => s.label)).toEqual([
      expect.stringMatching(LOCK)
    ])
    expect(mocks.enqueueS3Deletion).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueS3Deletion).toHaveBeenCalledWith(
      rec.module.prisma,
      newKeys()
    )
    // 事务已回滚, 回收用事务外的 client
    expect(rec.outside.map((s) => s.label)).toContain(
      '$executeRaw: -- enqueueS3Deletion'
    )
    expect(mocks.kickS3DeletionDrain).toHaveBeenCalledTimes(1)
    expect(mocks.kickSearchOutboxDrain).not.toHaveBeenCalled()
  })

  it('新版本写入失败: 不开事务, 这一组立即回收后抛出', async () => {
    mocks.uploadImageToS3.mockRejectedValue(new Error('S3 down'))

    await expect(replacePatchBanner(PATCH_ID, encoded)).rejects.toThrow(
      'S3 down'
    )

    expect(rec.attempts).toHaveLength(0)
    expect(mocks.enqueueS3Deletion).toHaveBeenCalledWith(
      rec.module.prisma,
      newKeys()
    )
    expect(mocks.kickS3DeletionDrain).toHaveBeenCalledTimes(1)
  })

  it('commit 抛错而指针已经是新版本 (其实提交了): 不回收新版本', async () => {
    rec.failNextCommit(new Error('connection reset'))
    rec.on('patch.findUnique', () => ({
      banner: (rec.argsOf('patch.update')[0] as { data: { banner: string } })
        .data.banner
    }))

    await expect(replacePatchBanner(PATCH_ID, encoded)).rejects.toThrow(
      'connection reset'
    )

    expect(callsWith(newKeys())).toHaveLength(0)
    expect(mocks.kickS3DeletionDrain).not.toHaveBeenCalled()
  })

  it('commit 抛错而指针还是旧的: 回收新版本', async () => {
    rec.failNextCommit(new Error('connection reset'))

    await expect(replacePatchBanner(PATCH_ID, encoded)).rejects.toThrow(
      'connection reset'
    )

    expect(callsWith(newKeys())).toEqual([[rec.module.prisma, newKeys()]])
    expect(mocks.kickS3DeletionDrain).toHaveBeenCalledTimes(1)
    expect(mocks.kickSearchOutboxDrain).not.toHaveBeenCalled()
  })
})
