import { beforeEach, describe, expect, it, vi } from 'vitest'

// bindUploadedResource 函数体的直接用例。只在适配器一层 (lib/s3、lib/redis、prisma) 打桩,
// 暂存校验与转正的实现搬到哪里都由这里钉住
const {
  copyObjectMock,
  promoteObjectMock,
  deleteFileFromS3Mock,
  headObjectMock,
  acquireKvLockMock,
  delKvMock,
  getKvMock,
  releaseKvLockMock,
  userUpdateManyMock,
  enqueueS3DeletionMock,
  invalidateUserSessionMock,
  prismaMock
} = vi.hoisted(() => {
  const userUpdateManyMock = vi.fn()
  return {
    copyObjectMock: vi.fn(),
    promoteObjectMock: vi.fn(),
    deleteFileFromS3Mock: vi.fn(),
    headObjectMock: vi.fn(),
    acquireKvLockMock: vi.fn(),
    delKvMock: vi.fn(),
    getKvMock: vi.fn(),
    releaseKvLockMock: vi.fn(),
    userUpdateManyMock,
    enqueueS3DeletionMock: vi.fn(),
    invalidateUserSessionMock: vi.fn(),
    prismaMock: { user: { updateMany: userUpdateManyMock } }
  }
})

vi.mock('~/lib/s3', () => ({
  copyObject: copyObjectMock,
  promoteObject: promoteObjectMock,
  deleteFileFromS3: deleteFileFromS3Mock,
  headObject: headObjectMock
}))

vi.mock('~/lib/redis', () => ({
  acquireKvLock: acquireKvLockMock,
  delKv: delKvMock,
  getKv: getKvMock,
  releaseKvLock: releaseKvLockMock
}))

vi.mock('~/prisma/index', () => ({ prisma: prismaMock }))

vi.mock('~/server/storage/s3Outbox', () => ({
  enqueueS3Deletion: enqueueS3DeletionMock,
  kickS3DeletionDrain: vi.fn()
}))

vi.mock('~/server/moderation/submit', () => ({
  deletePendingModerationTasks: vi.fn()
}))

vi.mock('~/server/moderation/appeal', () => ({
  deletePendingAppeals: vi.fn()
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: vi.fn()
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

import { bindUploadedResource } from '~/app/api/patch/resource/_helper'
import {
  RESOURCE_S3_COPY_TIMEOUT_MS,
  RESOURCE_S3_HEAD_TIMEOUT_MS
} from '~/constants/resource'

const UID = 7
const PATCH_ID = 10
const TOKEN = 'upload-token-0001'
const LOCK_TOKEN = 'lock-token'
const MB = 1024 * 1024
const SIZE = 2 * MB
const STAGING_KEY = `patch/tmp/${UID}/${'a'.repeat(64)}/game.zip`
const FINAL_KEY = new RegExp(
  `^patch/${PATCH_ID}/resource/[0-9a-f]{64}/game\\.zip$`
)
const STORAGE_URL = 'https://storage.test'

const TOKEN_MISSING = '上传 token 已过期或不存在, 请重新上传文件'
const TOKEN_FOREIGN = '上传 token 不属于当前用户'
const NOT_UPLOADED = '文件未上传成功, 请重新上传'
const SIZE_MISMATCH = '文件大小不一致, 请重新上传'
const TOO_LARGE = '文件大小超过限制, 必须小于 1GB'
const QUOTA_EXCEEDED = '您今日的上传大小已达到 5GB 限额'

const meta = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    s3Key: STAGING_KEY,
    fileName: 'game.zip',
    declared: SIZE,
    uid: UID,
    ...overrides
  })

const STAGED = { ContentLength: SIZE }
const PROMOTED = {
  ContentLength: SIZE,
  ContentType: 'application/octet-stream',
  ContentDisposition: 'attachment'
}

// 调用顺序是这条链路的承重部分 (先扣额度再复制、消费令牌与删暂存的先后), 统一记进一张表
let calls: string[]
// 转正后那次 HEAD 的应答; 暂存对象的 HEAD 由各用例直接改 headObjectMock
let promotedHead: () => unknown
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

const site = (key: unknown) => (key === STAGING_KEY ? 'staging' : 'final')

const record =
  <T>(name: string, result: () => T | Promise<T>) =>
  async () => {
    calls.push(name)
    return result()
  }

const bind = () => bindUploadedResource(PATCH_ID, TOKEN, UID)

const promotedKey = () => promoteObjectMock.mock.calls[0][1] as string

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('NEXT_PUBLIC_KUN_VISUAL_NOVEL_S3_STORAGE_URL', STORAGE_URL)
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  calls = []
  promotedHead = () => PROMOTED

  acquireKvLockMock.mockImplementation(
    record('acquireKvLock', () => LOCK_TOKEN)
  )
  releaseKvLockMock.mockImplementation(record('releaseKvLock', () => undefined))
  getKvMock.mockImplementation(record('getKv', () => meta()))
  delKvMock.mockImplementation(record('delKv', () => undefined))
  headObjectMock.mockImplementation(async (key: string) => {
    calls.push(`headObject:${site(key)}`)
    return key === STAGING_KEY ? STAGED : promotedHead()
  })
  promoteObjectMock.mockImplementation(record('promoteObject', () => ({})))
  deleteFileFromS3Mock.mockImplementation(async (key: string) => {
    calls.push(`deleteFileFromS3:${site(key)}`)
  })
  userUpdateManyMock.mockImplementation(
    record('user.updateMany', () => ({ count: 1 }))
  )
  enqueueS3DeletionMock.mockImplementation(
    record('enqueueS3Deletion', () => undefined)
  )
  invalidateUserSessionMock.mockImplementation(
    record('invalidateUserSession', () => undefined)
  )
})

describe('bindUploadedResource 绑定锁', () => {
  it('按 token 取锁; 锁被占时直接返回, 不读 token 也不释放别人的锁', async () => {
    acquireKvLockMock.mockResolvedValue(null)

    expect(await bind()).toBe('该上传 token 正在被处理, 请稍后再试')
    expect(acquireKvLockMock).toHaveBeenCalledWith(
      `upload-bind:${TOKEN}`,
      expect.any(Number)
    )
    expect(getKvMock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).not.toHaveBeenCalled()
  })

  it('锁的租期长于锁内三次带墙钟上限的 S3 调用之和 (暂存 HEAD、复制、转正后 HEAD)', async () => {
    await bind()

    const [, ttlSeconds] = acquireKvLockMock.mock.calls[0]
    expect(Number.isInteger(ttlSeconds)).toBe(true)
    expect(ttlSeconds * 1000).toBeGreaterThan(
      RESOURCE_S3_COPY_TIMEOUT_MS + 2 * RESOURCE_S3_HEAD_TIMEOUT_MS
    )
  })

  it('每条返回路径都用自己的锁令牌释放锁', async () => {
    getKvMock.mockResolvedValue(null)
    await bind()

    expect(releaseKvLockMock).toHaveBeenCalledWith(
      `upload-bind:${TOKEN}`,
      LOCK_TOKEN
    )
  })

  it('释放锁失败不改变结果', async () => {
    releaseKvLockMock.mockRejectedValue(new Error('redis down'))

    await expect(bind()).resolves.toMatchObject({ size: SIZE })
  })
})

describe('bindUploadedResource 令牌', () => {
  it('令牌不存在: 返回过期文案, 不碰对象存储与额度', async () => {
    getKvMock.mockResolvedValue(null)

    expect(await bind()).toBe(TOKEN_MISSING)
    expect(getKvMock).toHaveBeenCalledWith(`upload:${TOKEN}`)
    expect(headObjectMock).not.toHaveBeenCalled()
    expect(userUpdateManyMock).not.toHaveBeenCalled()
  })

  it('令牌属于别的用户: 拒绝, 不碰对方的暂存对象', async () => {
    getKvMock.mockResolvedValue(meta({ uid: UID + 1 }))

    expect(await bind()).toBe(TOKEN_FOREIGN)
    expect(headObjectMock).not.toHaveBeenCalled()
    expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
    expect(delKvMock).not.toHaveBeenCalled()
  })

  it.each([
    ['不是 JSON', 'not-json'],
    ['缺字段', '{}'],
    ['大小不是正整数', meta({ declared: 0 })],
    [
      '暂存 key 不在 patch/tmp/ 之下',
      meta({ s3Key: 'patch/1/resource/x/a.zip' })
    ]
  ])('令牌内容%s: 按令牌无效处理, 不拿它去碰对象存储', async (_, raw) => {
    getKvMock.mockResolvedValue(raw)

    expect(await bind()).toBe(TOKEN_MISSING)
    expect(headObjectMock).not.toHaveBeenCalled()
    expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).toHaveBeenCalledTimes(1)
  })
})

describe('bindUploadedResource 暂存对象校验', () => {
  it('HEAD 带墙钟上限', async () => {
    await bind()

    expect(headObjectMock.mock.calls[0]).toEqual([
      STAGING_KEY,
      expect.any(AbortSignal)
    ])
  })

  it('HEAD 失败: 返回未上传成功, 令牌与暂存都留着供重试', async () => {
    headObjectMock.mockRejectedValue(new Error('NotFound'))

    expect(await bind()).toBe(NOT_UPLOADED)
    expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
    expect(delKvMock).not.toHaveBeenCalled()
    expect(userUpdateManyMock).not.toHaveBeenCalled()
  })

  it('实际大小与声明不符: 拒绝并清掉暂存对象与令牌, 不扣额度', async () => {
    headObjectMock.mockResolvedValue({ ContentLength: SIZE + 1 })

    expect(await bind()).toBe(SIZE_MISMATCH)
    expect(deleteFileFromS3Mock).toHaveBeenCalledWith(STAGING_KEY)
    expect(delKvMock).toHaveBeenCalledWith(`upload:${TOKEN}`)
    expect(userUpdateManyMock).not.toHaveBeenCalled()
    expect(promoteObjectMock).not.toHaveBeenCalled()
  })

  it('HEAD 没给出大小: 按 0 处理, 同样判为大小不符', async () => {
    headObjectMock.mockResolvedValue({})

    expect(await bind()).toBe(SIZE_MISMATCH)
    expect(deleteFileFromS3Mock).toHaveBeenCalledWith(STAGING_KEY)
  })

  it('大小达到 1GB 上限: 拒绝并清理', async () => {
    const tooLarge = 1024 * MB
    getKvMock.mockResolvedValue(meta({ declared: tooLarge }))
    headObjectMock.mockResolvedValue({ ContentLength: tooLarge })

    expect(await bind()).toBe(TOO_LARGE)
    expect(deleteFileFromS3Mock).toHaveBeenCalledWith(STAGING_KEY)
    expect(delKvMock).toHaveBeenCalledWith(`upload:${TOKEN}`)
    expect(userUpdateManyMock).not.toHaveBeenCalled()
  })

  it('拒绝时的清理是尽力而为: 删对象失败仍删令牌, 文案照常返回', async () => {
    headObjectMock.mockResolvedValue({ ContentLength: SIZE + 1 })
    deleteFileFromS3Mock.mockRejectedValue(new Error('s3 down'))
    delKvMock.mockRejectedValue(new Error('redis down'))

    expect(await bind()).toBe(SIZE_MISMATCH)
    expect(delKvMock).toHaveBeenCalledWith(`upload:${TOKEN}`)
  })
})

describe('bindUploadedResource 每日额度', () => {
  it('以条件更新扣额度: 只有扣完不超过 5120 MB 才写入', async () => {
    await bind()

    expect(userUpdateManyMock).toHaveBeenCalledWith({
      where: { id: UID, daily_upload_size: { lte: 5120 - 2 } },
      data: { daily_upload_size: { increment: 2 } }
    })
  })

  it('额度不足: 拒绝并清掉暂存对象与令牌, 不复制', async () => {
    userUpdateManyMock.mockResolvedValue({ count: 0 })

    expect(await bind()).toBe(QUOTA_EXCEEDED)
    expect(deleteFileFromS3Mock).toHaveBeenCalledWith(STAGING_KEY)
    expect(delKvMock).toHaveBeenCalledWith(`upload:${TOKEN}`)
    expect(promoteObjectMock).not.toHaveBeenCalled()
  })
})

describe('bindUploadedResource 转正', () => {
  it('成功: 返回下载地址、正式 key 与实际大小, 并让会话里的额度失效', async () => {
    const result = await bind()

    expect(promoteObjectMock).toHaveBeenCalledTimes(1)
    const [srcKey, finalKey, signal] = promoteObjectMock.mock.calls[0]
    expect(srcKey).toBe(STAGING_KEY)
    expect(finalKey).toMatch(FINAL_KEY)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({
      downloadLink: `${STORAGE_URL}/${finalKey}`,
      s3Key: finalKey,
      size: SIZE
    })
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(UID)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('转正不走继承源对象元数据的 copyObject', async () => {
    await bind()

    expect(copyObjectMock).not.toHaveBeenCalled()
  })

  it('成功路径的顺序: 校验 → 扣额度 → 转正 → 核对正式对象 → 消费令牌 → 删暂存', async () => {
    await bind()

    expect(calls).toEqual([
      'acquireKvLock',
      'getKv',
      'headObject:staging',
      'user.updateMany',
      'promoteObject',
      'headObject:final',
      'delKv',
      'deleteFileFromS3:staging',
      'invalidateUserSession',
      'releaseKvLock'
    ])
  })

  it('每次绑定生成不同的随机段', async () => {
    await bind()
    await bind()

    const [first, second] = promoteObjectMock.mock.calls.map((call) => call[1])
    expect(first).not.toBe(second)
  })

  it('删暂存失败不影响绑定结果', async () => {
    deleteFileFromS3Mock.mockRejectedValue(new Error('s3 down'))

    await expect(bind()).resolves.toMatchObject({ size: SIZE })
    expect(delKvMock).toHaveBeenCalledWith(`upload:${TOKEN}`)
  })

  it('复制失败: 删掉可能已生成的正式对象, 退回额度, 原样抛出; 暂存与令牌留着供重试', async () => {
    const failure = new Error('copy timeout')
    promoteObjectMock.mockRejectedValue(failure)

    await expect(bind()).rejects.toBe(failure)

    expect(deleteFileFromS3Mock.mock.calls).toEqual([[promotedKey()]])
    expect(userUpdateManyMock).toHaveBeenLastCalledWith({
      where: { id: UID, daily_upload_size: { gte: 2 } },
      data: { daily_upload_size: { decrement: 2 } }
    })
    expect(delKvMock).not.toHaveBeenCalled()
    expect(enqueueS3DeletionMock).not.toHaveBeenCalled()
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).toHaveBeenCalledTimes(1)
  })

  it('复制失败且即时删除正式对象也失败: 交给删除出箱', async () => {
    const failure = new Error('copy timeout')
    promoteObjectMock.mockRejectedValue(failure)
    deleteFileFromS3Mock.mockRejectedValue(new Error('s3 down'))

    await expect(bind()).rejects.toBe(failure)

    expect(enqueueS3DeletionMock).toHaveBeenCalledWith(prismaMock, [
      promotedKey()
    ])
  })

  it('复制失败后的清理与退额度都失败: 仍抛出最初的错误', async () => {
    const failure = new Error('copy timeout')
    promoteObjectMock.mockRejectedValue(failure)
    deleteFileFromS3Mock.mockRejectedValue(new Error('s3 down'))
    enqueueS3DeletionMock.mockRejectedValue(new Error('db down'))
    userUpdateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('db down'))

    await expect(bind()).rejects.toBe(failure)
  })

  it('消费令牌失败: 删掉正式对象并退回额度后抛出; 暂存对象还在, 同一枚令牌可以重试', async () => {
    const failure = new Error('redis down')
    delKvMock.mockRejectedValue(failure)

    await expect(bind()).rejects.toBe(failure)

    expect(deleteFileFromS3Mock.mock.calls).toEqual([[promotedKey()]])
    expect(userUpdateManyMock).toHaveBeenLastCalledWith({
      where: { id: UID, daily_upload_size: { gte: 2 } },
      data: { daily_upload_size: { decrement: 2 } }
    })
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })
})

// 第一版只记日志: 存储是否遵从 MetadataDirective 要先在生产上观察。改成拒绝时, 这一组的
// 「绑定照常成功」翻成「按复制失败处理」
describe('bindUploadedResource 转正后核对正式对象的元数据', () => {
  it('HEAD 的是刚转正的那个 key, 带墙钟上限', async () => {
    await bind()

    expect(headObjectMock.mock.calls[1]).toEqual([
      promotedKey(),
      expect.any(AbortSignal)
    ])
  })

  it.each([
    ['类型不是二进制流', { ...PROMOTED, ContentType: 'text/html' }],
    ['没有按附件下载', { ...PROMOTED, ContentDisposition: undefined }],
    ['按内联展示', { ...PROMOTED, ContentDisposition: 'inline' }],
    ['大小与声明不符', { ...PROMOTED, ContentLength: SIZE - 1 }]
  ])('%s: 记一条日志, 绑定照常成功', async (_, info) => {
    promotedHead = () => info

    await expect(bind()).resolves.toMatchObject({ size: SIZE })
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy.mock.calls[0][1]).toMatchObject({
      finalKey: promotedKey()
    })
    expect(delKvMock).toHaveBeenCalledWith(`upload:${TOKEN}`)
  })

  it('带文件名参数的 attachment 也算数', async () => {
    promotedHead = () => ({
      ...PROMOTED,
      ContentDisposition: 'attachment; filename="game.zip"'
    })

    await bind()

    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('HEAD 失败: 记一条日志, 绑定照常成功', async () => {
    promotedHead = () => {
      throw new Error('s3 down')
    }

    await expect(bind()).resolves.toMatchObject({ size: SIZE })
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
  })
})
