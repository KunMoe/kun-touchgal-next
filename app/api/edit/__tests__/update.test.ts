import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  patchFindUniqueMock,
  patchFindFirstMock,
  transactionMock,
  patchUpdateMock,
  aliasDeleteManyMock,
  aliasCreateManyMock,
  enqueueSearchOutboxMock,
  queueSearchSyncMock,
  invalidatePatchContentCacheMock,
  processSubmittedExternalDataMock
} = vi.hoisted(() => ({
  patchFindUniqueMock: vi.fn(),
  patchFindFirstMock: vi.fn(),
  transactionMock: vi.fn(),
  patchUpdateMock: vi.fn(),
  aliasDeleteManyMock: vi.fn(),
  aliasCreateManyMock: vi.fn(),
  enqueueSearchOutboxMock: vi.fn(),
  queueSearchSyncMock: vi.fn(),
  invalidatePatchContentCacheMock: vi.fn(),
  processSubmittedExternalDataMock: vi.fn()
}))

const transactionClient = {
  patch: { update: patchUpdateMock },
  patch_alias: {
    deleteMany: aliasDeleteManyMock,
    createMany: aliasCreateManyMock
  }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: { findUnique: patchFindUniqueMock, findFirst: patchFindFirstMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: enqueueSearchOutboxMock,
  queueSearchSync: queueSearchSyncMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidatePatchContentCacheMock
}))

vi.mock('~/app/api/edit/processExternalData', () => ({
  processSubmittedExternalData: processSubmittedExternalDataMock
}))

import { updateGalgame } from '../update'

const makeInput = () => ({
  id: 5,
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
  steamAliases: [],
  introduction: '这是一段足够长的游戏介绍文本',
  tag: ['标签一'],
  alias: ['别名一'],
  contentLimit: 'sfw',
  released: '2026-01-01'
})

// 忠实模拟 Prisma 交互式事务的提交语义: 回调 resolve 即提交, 只有抛出才回滚.
// 断言 committed 才能区分"回滚"与"提交了半成品", 只断言返回值的话两者长得一模一样
let committed = false

describe('updateGalgame', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    committed = false
    patchFindUniqueMock.mockResolvedValue({ id: 5, unique_id: 'abcd1234' })
    patchFindFirstMock.mockResolvedValue(null)
    patchUpdateMock.mockResolvedValue({})
    invalidatePatchContentCacheMock.mockResolvedValue(undefined)
    transactionMock.mockImplementation(
      async (callback: (tx: typeof transactionClient) => unknown) => {
        const result = await callback(transactionClient)
        committed = true
        return result
      }
    )
  })

  it('vndb_id 与 relation_id 组合被其它 Galgame 占用时返回重复提示, 不开启事务', async () => {
    patchFindFirstMock.mockResolvedValue({ id: 99, unique_id: 'deadbeef' })

    const res = await updateGalgame(
      { ...makeInput(), vndbId: 'V19658', vndbRelationId: 'R57171' },
      1
    )

    expect(res).toBe(
      'Galgame VNDB ID 与 Relation ID 的组合与游戏 ID 为 deadbeef 的游戏重复'
    )
    expect(patchFindFirstMock).toHaveBeenCalledWith({
      where: { vndb_id: 'v19658', vndb_relation_id: 'r57171' },
      select: { id: true, unique_id: true }
    })
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('单独 vndb_id (relation 为空) 被其它 Galgame 占用时返回重复提示, 查询须按 null 精确匹配形态', async () => {
    patchFindFirstMock.mockResolvedValue({ id: 99, unique_id: 'deadbeef' })

    const res = await updateGalgame({ ...makeInput(), vndbId: 'V19658' }, 1)

    expect(res).toBe('Galgame VNDB ID 与游戏 ID 为 deadbeef 的游戏重复')
    // vndb_relation_id 必须显式为 null: 裸单字段查询会把 (v, r) 形态的行也判为
    // 重复, 错误拦截"同 vndb_id 不同 relation"的合法共存
    expect(patchFindFirstMock).toHaveBeenCalledWith({
      where: { vndb_id: 'v19658', vndb_relation_id: null },
      select: { id: true, unique_id: true }
    })
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('单独 relation_id (vndb_id 为空) 被其它 Galgame 占用时返回重复提示, 不开启事务', async () => {
    patchFindFirstMock.mockResolvedValue({ id: 99, unique_id: 'deadbeef' })

    const res = await updateGalgame(
      { ...makeInput(), vndbRelationId: 'R57171' },
      1
    )

    expect(res).toBe(
      'Galgame VNDB Relation ID 与游戏 ID 为 deadbeef 的游戏重复'
    )
    expect(patchFindFirstMock).toHaveBeenCalledWith({
      where: { vndb_id: null, vndb_relation_id: 'r57171' },
      select: { id: true, unique_id: true }
    })
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('dlsite_code 被其它 Galgame 占用时返回重复提示, 不开启事务', async () => {
    patchFindFirstMock.mockResolvedValue({ id: 99, unique_id: 'deadbeef' })

    const res = await updateGalgame(
      { ...makeInput(), dlsiteCode: 'rj123456' },
      1
    )

    expect(res).toBe('Galgame DLSite Code 与游戏 ID 为 deadbeef 的游戏重复')
    expect(patchFindFirstMock).toHaveBeenCalledWith({
      where: { dlsite_code: 'RJ123456' },
      select: { id: true, unique_id: true }
    })
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('bangumi_id 被其它 Galgame 占用时返回重复提示, 不开启事务', async () => {
    patchFindFirstMock.mockResolvedValue({ id: 99, unique_id: 'deadbeef' })

    const res = await updateGalgame({ ...makeInput(), bangumiId: '123456' }, 1)

    expect(res).toBe('Galgame Bangumi ID 与游戏 ID 为 deadbeef 的游戏重复')
    expect(patchFindFirstMock).toHaveBeenCalledWith({
      where: { bangumi_id: 123456 },
      select: { id: true, unique_id: true }
    })
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('steam_id 被其它 Galgame 占用时返回重复提示, 不开启事务', async () => {
    patchFindFirstMock.mockResolvedValue({ id: 99, unique_id: 'deadbeef' })

    const res = await updateGalgame({ ...makeInput(), steamId: '654321' }, 1)

    expect(res).toBe('Galgame Steam ID 与游戏 ID 为 deadbeef 的游戏重复')
    expect(patchFindFirstMock).toHaveBeenCalledWith({
      where: { steam_id: 654321 },
      select: { id: true, unique_id: true }
    })
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('外部 ID 的占用方是自身时不误报, 正常写入', async () => {
    patchFindFirstMock.mockResolvedValue({ id: 5, unique_id: 'abcd1234' })

    const res = await updateGalgame(
      { ...makeInput(), bangumiId: '123456', steamId: '654321' },
      1
    )

    expect(res).toEqual({})
    expect(committed).toBe(true)
    expect(patchUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
        data: expect.objectContaining({ bangumi_id: 123456, steam_id: 654321 })
      })
    )
  })

  it('存在性检查与四条外部 ID 预检并行发出, 不逐条 await', async () => {
    let releasePatch: (value: { unique_id: string }) => void = () => {}
    const releaseFindFirst: Array<(value: null) => void> = []
    patchFindUniqueMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePatch = resolve
        })
    )
    patchFindFirstMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFindFirst.push(resolve)
        })
    )

    const pending = updateGalgame(
      {
        ...makeInput(),
        vndbId: 'V19658',
        dlsiteCode: 'RJ123456',
        bangumiId: '123456',
        steamId: '654321'
      },
      1
    )

    // async 函数在首个 await 前同步求值整个 Promise.all 数组, 五条查询此时都已发出;
    // 串行形态在 findUnique 挂起期间一条 findFirst 都不会发
    expect(patchFindUniqueMock).toHaveBeenCalledTimes(1)
    expect(patchFindFirstMock).toHaveBeenCalledTimes(4)

    releasePatch({ unique_id: 'abcd1234' })
    releaseFindFirst.forEach((release) => release(null))
    expect(await pending).toEqual({})
    expect(committed).toBe(true)
  })

  it('多个外部 ID 同时撞车时按 vndb → dlsite → bangumi → steam 顺序只报第一条', async () => {
    patchFindFirstMock.mockResolvedValue({ id: 99, unique_id: 'deadbeef' })

    const res = await updateGalgame(
      {
        ...makeInput(),
        vndbId: 'V19658',
        dlsiteCode: 'RJ123456',
        bangumiId: '123456',
        steamId: '654321'
      },
      1
    )

    expect(res).toBe('Galgame VNDB ID 与游戏 ID 为 deadbeef 的游戏重复')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('预检与 update 之间的并发窗口撞唯一索引时翻成字符串而非 500', async () => {
    patchUpdateMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique constraint', {
        code: 'P2002',
        clientVersion: 'test'
      })
    )

    const res = await updateGalgame({ ...makeInput(), steamId: '654321' }, 1)

    expect(res).toBe('您填写的外部 ID 已经被其它 Galgame 使用, 请检查后重试')
    expect(committed).toBe(false)
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(aliasDeleteManyMock).not.toHaveBeenCalled()
    expect(processSubmittedExternalDataMock).not.toHaveBeenCalled()
    expect(queueSearchSyncMock).not.toHaveBeenCalled()
    expect(invalidatePatchContentCacheMock).not.toHaveBeenCalled()
  })

  it('非 P2002 的错误继续抛出', async () => {
    patchUpdateMock.mockRejectedValue(new Error('connection lost'))

    await expect(updateGalgame(makeInput(), 1)).rejects.toThrow(
      'connection lost'
    )
  })

  it('alias 去重后写入: patch_alias 无唯一约束, skipDuplicates 挡不住批内重复', async () => {
    const res = await updateGalgame(
      { ...makeInput(), alias: ['LOOPERS', 'LOOPERS', ' LOOPERS '] },
      1
    )

    expect(res).toEqual({})
    expect(aliasCreateManyMock).toHaveBeenCalledWith({
      data: [{ name: 'LOOPERS', patch_id: 5 }],
      skipDuplicates: true
    })
  })

  it('无外部 ID 冲突时走完整条更新链路', async () => {
    const res = await updateGalgame(makeInput(), 1)

    expect(res).toEqual({})
    expect(committed).toBe(true)
    expect(transactionMock).toHaveBeenCalledTimes(2)
    expect(patchUpdateMock).toHaveBeenCalledTimes(1)
    expect(aliasDeleteManyMock).toHaveBeenCalledTimes(1)
    expect(aliasCreateManyMock).toHaveBeenCalledTimes(1)
    expect(enqueueSearchOutboxMock).toHaveBeenCalledWith(transactionClient, 5)
    expect(processSubmittedExternalDataMock).toHaveBeenCalledTimes(1)
    expect(queueSearchSyncMock).toHaveBeenCalledWith(5)
    expect(invalidatePatchContentCacheMock).toHaveBeenCalledWith('abcd1234')
  })
})
