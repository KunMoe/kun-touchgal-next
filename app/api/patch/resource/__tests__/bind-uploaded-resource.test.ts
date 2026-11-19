import { beforeEach, describe, expect, it, vi } from 'vitest'

// bindUploadedResource 函数体的直接用例。只在适配器一层 (lib/s3、lib/redis、prisma) 打桩,
// 暂存校验与转正的实现搬到哪里都由这里钉住
const {
  copyObjectMock,
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

// 调用顺序是这条链路的承重部分 (先扣额度再复制、消费令牌与删暂存的先后), 统一记进一张表
let calls: string[]

const record =
  <T>(name: string, result: () => T | Promise<T>) =>
  async (...args: unknown[]) => {
    calls.push(
      name === 'deleteFileFromS3' || name === 'headObject'
        ? `${name}:${args[0] === STAGING_KEY ? 'staging' : 'final'}`
        : name
    )
    return result()
  }

const bind = () => bindUploadedResource(PATCH_ID, TOKEN, UID)

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('NEXT_PUBLIC_KUN_VISUAL_NOVEL_S3_STORAGE_URL', STORAGE_URL)
  calls = []

  acquireKvLockMock.mockImplementation(
    record('acquireKvLock', () => LOCK_TOKEN)
  )
  releaseKvLockMock.mockImplementation(record('releaseKvLock', () => undefined))
  getKvMock.mockImplementation(record('getKv', () => meta()))
  delKvMock.mockImplementation(record('delKv', () => undefined))
  headObjectMock.mockImplementation(
    record('headObject', () => ({ ContentLength: SIZE }))
  )
  copyObjectMock.mockImplementation(record('copyObject', () => ({})))
  deleteFileFromS3Mock.mockImplementation(
    record('deleteFileFromS3', () => undefined)
  )
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

  it('锁的租期盖得住锁内最长的 S3 调用 (复制 60 秒)', async () => {
    await bind()

    const [, ttlSeconds] = acquireKvLockMock.mock.calls[0]
    expect(ttlSeconds).toBeGreaterThanOrEqual(60)
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

  // 预期翻转 (S2): 令牌内容改由 schema 解析, 损坏的内容按令牌无效返回文案, 不再抛错
  it('令牌内容不是 JSON: 抛出解析错误, 锁照常释放', async () => {
    getKvMock.mockResolvedValue('not-json')

    await expect(bind()).rejects.toBeInstanceOf(SyntaxError)
    expect(headObjectMock).not.toHaveBeenCalled()
    expect(releaseKvLockMock).toHaveBeenCalledTimes(1)
  })

  // 预期翻转 (S2): 形状不对的令牌一律按令牌无效处理
  it('令牌是 JSON 但缺字段: 因 uid 对不上被当成别人的令牌', async () => {
    getKvMock.mockResolvedValue('{}')

    expect(await bind()).toBe(TOKEN_FOREIGN)
    expect(headObjectMock).not.toHaveBeenCalled()
  })

  // 预期翻转 (S2): 暂存 key 必须落在 patch/tmp/ 之下, 否则按令牌无效处理
  it('令牌里的 key 不在暂存前缀下: 照样拿去 HEAD', async () => {
    getKvMock.mockResolvedValue(meta({ s3Key: 'patch/1/resource/x/game.zip' }))

    await bind()

    expect(headObjectMock).toHaveBeenCalledWith('patch/1/resource/x/game.zip')
  })
})

describe('bindUploadedResource 暂存对象校验', () => {
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
    expect(copyObjectMock).not.toHaveBeenCalled()
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
    expect(copyObjectMock).not.toHaveBeenCalled()
  })
})

describe('bindUploadedResource 转正', () => {
  it('成功: 返回下载地址、正式 key 与实际大小, 并让会话里的额度失效', async () => {
    const result = await bind()

    expect(copyObjectMock).toHaveBeenCalledTimes(1)
    const [srcKey, finalKey, signal] = copyObjectMock.mock.calls[0]
    expect(srcKey).toBe(STAGING_KEY)
    expect(finalKey).toMatch(FINAL_KEY)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({
      downloadLink: `${STORAGE_URL}/${finalKey}`,
      s3Key: finalKey,
      size: SIZE
    })
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(UID)
  })

  // 预期翻转 (S3): 改为先消费令牌再删暂存, 并在复制后对正式 key 做一次 HEAD
  it('成功路径的顺序: 校验 → 扣额度 → 复制 → 删暂存 → 消费令牌', async () => {
    await bind()

    expect(calls).toEqual([
      'acquireKvLock',
      'getKv',
      'headObject:staging',
      'user.updateMany',
      'copyObject',
      'deleteFileFromS3:staging',
      'delKv',
      'invalidateUserSession',
      'releaseKvLock'
    ])
  })

  it('每次绑定生成不同的随机段', async () => {
    await bind()
    await bind()

    const [first, second] = copyObjectMock.mock.calls.map((call) => call[1])
    expect(first).not.toBe(second)
  })

  it('删暂存失败不影响绑定结果', async () => {
    deleteFileFromS3Mock.mockRejectedValue(new Error('s3 down'))

    await expect(bind()).resolves.toMatchObject({ size: SIZE })
    expect(delKvMock).toHaveBeenCalledWith(`upload:${TOKEN}`)
  })

  it('复制失败: 删掉可能已生成的正式对象, 退回额度, 原样抛出; 暂存与令牌留着供重试', async () => {
    const failure = new Error('copy timeout')
    copyObjectMock.mockRejectedValue(failure)

    await expect(bind()).rejects.toBe(failure)

    const finalKey = copyObjectMock.mock.calls[0][1]
    expect(deleteFileFromS3Mock.mock.calls).toEqual([[finalKey]])
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
    copyObjectMock.mockRejectedValue(failure)
    deleteFileFromS3Mock.mockRejectedValue(new Error('s3 down'))

    await expect(bind()).rejects.toBe(failure)

    const finalKey = copyObjectMock.mock.calls[0][1]
    expect(enqueueS3DeletionMock).toHaveBeenCalledWith(prismaMock, [finalKey])
  })

  it('复制失败后的清理与退额度都失败: 仍抛出最初的错误', async () => {
    const failure = new Error('copy timeout')
    copyObjectMock.mockRejectedValue(failure)
    deleteFileFromS3Mock.mockRejectedValue(new Error('s3 down'))
    enqueueS3DeletionMock.mockRejectedValue(new Error('db down'))
    userUpdateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('db down'))

    await expect(bind()).rejects.toBe(failure)
  })

  // 预期翻转 (S3): 令牌先于暂存对象消费, 消费失败时暂存对象还在, 可以原样重试
  it('消费令牌失败: 删掉正式对象并退回额度后抛出; 此时暂存对象已经删了', async () => {
    const failure = new Error('redis down')
    delKvMock.mockRejectedValue(failure)

    await expect(bind()).rejects.toBe(failure)

    const finalKey = copyObjectMock.mock.calls[0][1]
    expect(deleteFileFromS3Mock.mock.calls).toEqual([[STAGING_KEY], [finalKey]])
    expect(userUpdateManyMock).toHaveBeenLastCalledWith({
      where: { id: UID, daily_upload_size: { gte: 2 } },
      data: { daily_upload_size: { decrement: 2 } }
    })
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })
})
