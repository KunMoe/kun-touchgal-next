import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  uploadImageToS3Mock,
  deleteFileFromS3Mock,
  enqueueS3DeletionMock,
  kickS3DeletionDrainMock,
  patchFindFirstMock,
  patchFindUniqueMock,
  transactionMock,
  patchCreateMock,
  patchUpdateMock,
  ratingStatCreateMock,
  aliasCreateManyMock,
  userUpdateMock,
  enqueueSearchOutboxMock,
  queueSearchSyncMock,
  invalidateUserSessionMock,
  processSubmittedExternalDataMock,
  postToIndexNowMock
} = vi.hoisted(() => ({
  uploadImageToS3Mock: vi.fn(),
  deleteFileFromS3Mock: vi.fn(),
  enqueueS3DeletionMock: vi.fn(),
  kickS3DeletionDrainMock: vi.fn(),
  patchFindFirstMock: vi.fn(),
  patchFindUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  patchCreateMock: vi.fn(),
  patchUpdateMock: vi.fn(),
  ratingStatCreateMock: vi.fn(),
  aliasCreateManyMock: vi.fn(),
  userUpdateMock: vi.fn(),
  enqueueSearchOutboxMock: vi.fn(),
  queueSearchSyncMock: vi.fn(),
  invalidateUserSessionMock: vi.fn(),
  processSubmittedExternalDataMock: vi.fn(),
  postToIndexNowMock: vi.fn()
}))

const transactionClient = {
  patch: { create: patchCreateMock, update: patchUpdateMock },
  patch_rating_stat: { create: ratingStatCreateMock },
  patch_alias: { createMany: aliasCreateManyMock },
  user: { update: userUpdateMock }
}

vi.mock('~/lib/s3', () => ({
  uploadImageToS3: uploadImageToS3Mock,
  deleteFileFromS3: deleteFileFromS3Mock
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  enqueueS3Deletion: enqueueS3DeletionMock,
  kickS3DeletionDrain: kickS3DeletionDrainMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: { findFirst: patchFindFirstMock, findUnique: patchFindUniqueMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: enqueueSearchOutboxMock,
  queueSearchSync: queueSearchSyncMock
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

vi.mock('~/app/api/edit/processExternalData', () => ({
  processSubmittedExternalData: processSubmittedExternalDataMock
}))

vi.mock('~/app/api/edit/_postToIndexNow', () => ({
  postToIndexNow: postToIndexNowMock
}))

import { createGalgame } from '../create'

const createPng = async (
  width: number,
  height: number
): Promise<ArrayBuffer> => {
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 150, b: 200 }
    }
  })
    .png()
    .toBuffer()
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength
  ) as ArrayBuffer
}

const makeInput = (banner: ArrayBuffer) => ({
  name: '测试 Galgame',
  vndbId: '',
  vndbRelationId: '',
  bangumiId: '',
  steamId: '',
  dlsiteCode: '',
  dlsiteCircleName: '',
  dlsiteCircleLink: '',
  vndbTags: [],
  vndbDevelopers: [],
  bangumiTags: [],
  bangumiDevelopers: [],
  steamTags: [],
  steamDevelopers: [],
  dlsiteTags: [],
  alias: ['别名一'],
  tag: ['标签一'],
  banner,
  introduction: '这是一段足够长的游戏介绍文本',
  released: '2026-01-01',
  contentLimit: 'nsfw'
})

// 忠实模拟 Prisma 交互式事务的提交语义: 回调 resolve 即提交(哪怕 resolve 的是表示
// 业务错误的字符串), 只有抛出才回滚. 断言 committed 才能区分"回滚"与"提交了半成品",
// 只断言返回值的话两者长得一模一样 —— 而那正是本文件守护的缺陷类
let committed = false

describe('createGalgame', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    committed = false
    uploadImageToS3Mock.mockResolvedValue(undefined)
    deleteFileFromS3Mock.mockResolvedValue(undefined)
    patchFindFirstMock.mockResolvedValue(null)
    // 补偿清理的守卫查询: 默认 null = 事务确已回滚
    patchFindUniqueMock.mockResolvedValue(null)
    patchCreateMock.mockResolvedValue({ id: 42 })
    transactionMock.mockImplementation(
      async (callback: (tx: typeof transactionClient) => unknown) => {
        const result = await callback(transactionClient)
        committed = true
        return result
      }
    )
  })

  it('banner 编码失败时不开启事务, 不留下半成品 patch 行', async () => {
    const bomb = await createPng(8000, 7000) // 56M > 50M 像素上限

    const res = await createGalgame(makeInput(bomb), 1)

    expect(res).toBe('图片尺寸过大')
    expect(transactionMock).not.toHaveBeenCalled()
    expect(patchCreateMock).not.toHaveBeenCalled()
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  }, 30000)

  it('S3 上传失败时抛出而非返回, 使事务回滚', async () => {
    const image = await createPng(400, 300)
    uploadImageToS3Mock.mockRejectedValue(new Error('S3 down'))

    await expect(createGalgame(makeInput(image), 1)).rejects.toThrow('S3 down')
    expect(committed).toBe(false)
    expect(patchUpdateMock).not.toHaveBeenCalled()
    expect(enqueueSearchOutboxMock).not.toHaveBeenCalled()
    // keys 赋值早于上传: PUT 的 Promise.all 部分成功也会被补偿清理 (删除幂等)
    expect(deleteFileFromS3Mock).toHaveBeenCalledTimes(2)
  }, 30000)

  it('bangumi_id 预检命中时返回重复提示, 不开启事务', async () => {
    const image = await createPng(400, 300)
    patchFindFirstMock.mockResolvedValue({ unique_id: 'deadbeef' })

    const res = await createGalgame(
      { ...makeInput(image), bangumiId: '123456' },
      1
    )

    expect(res).toBe('Galgame Bangumi ID 与游戏 ID 为 deadbeef 的游戏重复')
    expect(patchFindFirstMock).toHaveBeenCalledWith({
      where: { bangumi_id: 123456 },
      select: { unique_id: true }
    })
    expect(transactionMock).not.toHaveBeenCalled()
  }, 30000)

  it('单独 vndb_id (relation 为空) 预检命中时返回重复提示, 查询须按 null 精确匹配形态', async () => {
    const image = await createPng(400, 300)
    patchFindFirstMock.mockResolvedValue({ unique_id: 'deadbeef' })

    const res = await createGalgame(
      { ...makeInput(image), vndbId: 'V19658' },
      1
    )

    expect(res).toBe('Galgame VNDB ID 与游戏 ID 为 deadbeef 的游戏重复')
    // vndb_relation_id 必须显式为 null: 裸单字段查询会把 (v, r) 形态的行也判为
    // 重复, 错误拦截"同 vndb_id 不同 relation"的合法共存
    expect(patchFindFirstMock).toHaveBeenCalledWith({
      where: { vndb_id: 'v19658', vndb_relation_id: null },
      select: { unique_id: true }
    })
    expect(transactionMock).not.toHaveBeenCalled()
  }, 30000)

  it('单独 relation_id (vndb_id 为空) 预检命中时返回重复提示, 不开启事务', async () => {
    const image = await createPng(400, 300)
    patchFindFirstMock.mockResolvedValue({ unique_id: 'deadbeef' })

    const res = await createGalgame(
      { ...makeInput(image), vndbRelationId: 'R57171' },
      1
    )

    expect(res).toBe(
      'Galgame VNDB Relation ID 与游戏 ID 为 deadbeef 的游戏重复'
    )
    expect(patchFindFirstMock).toHaveBeenCalledWith({
      where: { vndb_id: null, vndb_relation_id: 'r57171' },
      select: { unique_id: true }
    })
    expect(transactionMock).not.toHaveBeenCalled()
  }, 30000)

  it('预检与 create 之间的并发窗口撞唯一索引时翻成字符串而非 500', async () => {
    const image = await createPng(400, 300)
    patchCreateMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique constraint', {
        code: 'P2002',
        clientVersion: 'test'
      })
    )

    const res = await createGalgame(
      { ...makeInput(image), steamId: '654321' },
      1
    )

    expect(res).toBe('您填写的外部 ID 已经被其它 Galgame 使用, 请检查后重试')
    expect(committed).toBe(false)
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
    expect(queueSearchSyncMock).not.toHaveBeenCalled()
    // P2002 抛自 patch.create, 早于上传, 不应触发 banner 补偿清理
    expect(patchFindUniqueMock).not.toHaveBeenCalled()
    expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
  }, 30000)

  it('上传成功后事务内步骤失败时, 补偿删除已上传的 banner 对象', async () => {
    const image = await createPng(400, 300)
    ratingStatCreateMock.mockRejectedValueOnce(new Error('db glitch'))

    await expect(createGalgame(makeInput(image), 1)).rejects.toThrow(
      'db glitch'
    )
    expect(committed).toBe(false)
    expect(deleteFileFromS3Mock).toHaveBeenCalledWith(
      'patch/42/banner/banner.avif'
    )
    expect(deleteFileFromS3Mock).toHaveBeenCalledWith(
      'patch/42/banner/banner-mini.avif'
    )
    expect(deleteFileFromS3Mock).toHaveBeenCalledTimes(2)
    expect(enqueueS3DeletionMock).not.toHaveBeenCalled()
  }, 30000)

  it('补偿即时删除失败时, 失败的 key 落删除写出箱兜底', async () => {
    const image = await createPng(400, 300)
    ratingStatCreateMock.mockRejectedValueOnce(new Error('db glitch'))
    deleteFileFromS3Mock.mockRejectedValue(new Error('S3 flaky'))

    await expect(createGalgame(makeInput(image), 1)).rejects.toThrow(
      'db glitch'
    )
    const { prisma } = await import('~/prisma/index')
    // 入箱必须用全局 client (事务已回滚, tx client 不可用)
    expect(enqueueS3DeletionMock).toHaveBeenCalledWith(prisma, [
      'patch/42/banner/banner.avif',
      'patch/42/banner/banner-mini.avif'
    ])
    expect(kickS3DeletionDrainMock).toHaveBeenCalledTimes(1)
  }, 30000)

  it('patch 行仍存在 (commit 响应丢失但实际已提交) 时不删 S3 对象', async () => {
    const image = await createPng(400, 300)
    ratingStatCreateMock.mockRejectedValueOnce(new Error('connection reset'))
    patchFindUniqueMock.mockResolvedValue({ id: 42 })

    await expect(createGalgame(makeInput(image), 1)).rejects.toThrow(
      'connection reset'
    )
    expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
    expect(enqueueS3DeletionMock).not.toHaveBeenCalled()
  }, 30000)

  it('非 P2002 的错误继续抛出', async () => {
    const image = await createPng(400, 300)
    patchCreateMock.mockRejectedValue(new Error('connection lost'))

    await expect(createGalgame(makeInput(image), 1)).rejects.toThrow(
      'connection lost'
    )
  }, 30000)

  it('正常图片走完整条创建链路', async () => {
    const image = await createPng(400, 300)

    const res = await createGalgame(makeInput(image), 1)

    expect(typeof res).toBe('object')
    expect(committed).toBe(true)
    // 事务里有 banner 上传, 靠 60 秒超时撑住; 执行器自己的选项不能混进 Prisma 的事务选项
    expect(transactionMock).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 60000
    })
    expect(patchCreateMock).toHaveBeenCalledTimes(1)
    expect(uploadImageToS3Mock).toHaveBeenCalledTimes(2)
    expect(patchUpdateMock).toHaveBeenCalledTimes(1)
    expect(ratingStatCreateMock).toHaveBeenCalledTimes(1)
    expect(aliasCreateManyMock).toHaveBeenCalledTimes(1)
    expect(userUpdateMock).toHaveBeenCalledTimes(1)
    expect(enqueueSearchOutboxMock).toHaveBeenCalledWith(transactionClient, 42)
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(1)
    expect(processSubmittedExternalDataMock).toHaveBeenCalledTimes(1)
    expect(queueSearchSyncMock).toHaveBeenCalledWith(42)
  }, 30000)

  it('DLsite 标签随外部来源透传, 不混入手动标签', async () => {
    const image = await createPng(400, 300)

    await createGalgame({ ...makeInput(image), dlsiteTags: ['純愛'] }, 1)

    expect(processSubmittedExternalDataMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ dlsiteTags: ['純愛'] }),
      // 建档时手动标签全部是新增, 没有可移除的
      { removeTagIds: [], addTagNames: ['标签一'] },
      1
    )
  }, 30000)
})
