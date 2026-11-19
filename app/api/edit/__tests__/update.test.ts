import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  patchFindUniqueMock,
  patchFindFirstMock,
  transactionMock,
  lockPatchRowMock,
  storedPatchFindUniqueMock,
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
  lockPatchRowMock: vi.fn(),
  storedPatchFindUniqueMock: vi.fn(),
  patchUpdateMock: vi.fn(),
  aliasDeleteManyMock: vi.fn(),
  aliasCreateManyMock: vi.fn(),
  enqueueSearchOutboxMock: vi.fn(),
  queueSearchSyncMock: vi.fn(),
  invalidatePatchContentCacheMock: vi.fn(),
  processSubmittedExternalDataMock: vi.fn()
}))

const transactionClient = {
  // 事务第一条语句: SELECT … FROM patch … FOR UPDATE
  $executeRaw: lockPatchRowMock,
  patch: { findUnique: storedPatchFindUniqueMock, update: patchUpdateMock },
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
import {
  galgameEditFieldsFromRow,
  galgameEditFingerprint
} from '../_editFields'

// 事务里在行锁下读到的当前值 (形状同 GALGAME_EDIT_SELECT)
const makeStoredRow = () => ({
  name: '改之前的名字',
  introduction: '改之前的游戏介绍文本, 足够长',
  content_limit: 'sfw',
  released: '2025-12-31',
  vndb_id: null as string | null,
  vndb_relation_id: null as string | null,
  bangumi_id: null as number | null,
  steam_id: null as number | null,
  dlsite_code: null as string | null,
  alias: [{ name: '旧别名' }]
})

const fingerprintOf = (row: ReturnType<typeof makeStoredRow>) =>
  galgameEditFingerprint(galgameEditFieldsFromRow(row))

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
  dlsiteTags: [],
  introduction: '这是一段足够长的游戏介绍文本',
  removeTagIds: [11],
  addTagNames: ['标签一'],
  alias: ['别名一'],
  contentLimit: 'sfw',
  released: '2026-01-01' as string | undefined,
  // 表单打开时读到的就是库里现在这一份
  baseFingerprint: fingerprintOf(makeStoredRow())
})

// 提交落库之后库里的样子: 重试时行锁下读到的就是它
const storedRowAfter = (input: ReturnType<typeof makeInput>) => ({
  ...makeStoredRow(),
  name: input.name,
  introduction: input.introduction,
  content_limit: input.contentLimit,
  released: input.released ?? makeStoredRow().released,
  alias: input.alias.map((name) => ({ name }))
})

// 忠实模拟 Prisma 交互式事务的提交语义: 回调 resolve 即提交, 只有抛出才回滚.
// 断言 committed 才能区分"回滚"与"提交了半成品", 只断言返回值的话两者长得一模一样
let committed = false

beforeEach(() => {
  vi.clearAllMocks()
  committed = false
  patchFindUniqueMock.mockResolvedValue({ id: 5, unique_id: 'abcd1234' })
  patchFindFirstMock.mockResolvedValue(null)
  lockPatchRowMock.mockResolvedValue(1)
  storedPatchFindUniqueMock.mockResolvedValue(makeStoredRow())
  patchUpdateMock.mockResolvedValue({})
  aliasDeleteManyMock.mockResolvedValue({ count: 1 })
  aliasCreateManyMock.mockResolvedValue({ count: 1 })
  invalidatePatchContentCacheMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => unknown) => {
      const result = await callback(transactionClient)
      committed = true
      return result
    }
  )
})

describe('updateGalgame', () => {
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
    // patch 字段与别名在同一个事务里: 行锁 → 读当前值 → 写字段 → 换别名 → 入队
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(patchUpdateMock).toHaveBeenCalledTimes(1)
    expect(aliasDeleteManyMock).toHaveBeenCalledTimes(1)
    expect(aliasCreateManyMock).toHaveBeenCalledTimes(1)
    expect(enqueueSearchOutboxMock).toHaveBeenCalledWith(transactionClient, 5)
    const order = [
      lockPatchRowMock,
      storedPatchFindUniqueMock,
      patchUpdateMock,
      aliasDeleteManyMock,
      aliasCreateManyMock,
      enqueueSearchOutboxMock
    ].map((mock) => mock.mock.invocationCallOrder[0])
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // 行锁一步取到 FOR UPDATE: 先取较弱的锁再升级会与子表插入互等 (update.db.test 实测)
    const [lockSql, lockedId] = lockPatchRowMock.mock.calls[0]
    expect(lockSql.join('?')).toBe(
      'SELECT id FROM patch WHERE id = ? FOR UPDATE'
    )
    expect(lockedId).toBe(5)
    expect(processSubmittedExternalDataMock).toHaveBeenCalledTimes(1)
    expect(queueSearchSyncMock).toHaveBeenCalledWith(5)
    expect(invalidatePatchContentCacheMock).toHaveBeenCalledWith('abcd1234')
  })

  it('DLsite 标签随外部来源透传, 手动标签按差量原样下传', async () => {
    await updateGalgame({ ...makeInput(), dlsiteTags: ['純愛'] }, 1)

    expect(processSubmittedExternalDataMock).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ dlsiteTags: ['純愛'] }),
      { removeTagIds: [11], addTagNames: ['标签一'] },
      1
    )
  })

  it('写入的是规范化之后的值: 提交落库后库里的值与本次提交的指纹一致', async () => {
    await updateGalgame(
      {
        ...makeInput(),
        name: '  测试 Galgame  ',
        vndbId: ' V19658 ',
        dlsiteCode: 'rj123456',
        bangumiId: '123456'
      },
      1
    )

    expect(patchUpdateMock).toHaveBeenCalledWith({
      where: { id: 5 },
      data: {
        name: '测试 Galgame',
        vndb_id: 'v19658',
        vndb_relation_id: null,
        bangumi_id: 123456,
        steam_id: null,
        dlsite_code: 'RJ123456',
        introduction: '这是一段足够长的游戏介绍文本',
        content_limit: 'sfw',
        released: '2026-01-01'
      }
    })
  })

  it('released 缺省时不动库里的值, 也不因此被判成冲突', async () => {
    const res = await updateGalgame({ ...makeInput(), released: undefined }, 1)

    expect(res).toEqual({})
    expect(patchUpdateMock.mock.calls[0][0].data.released).toBe('2025-12-31')
  })
})

describe('updateGalgame 的编辑并发令牌', () => {
  const expectNothingWritten = () => {
    expect(committed).toBe(false)
    expect(patchUpdateMock).not.toHaveBeenCalled()
    expect(aliasDeleteManyMock).not.toHaveBeenCalled()
    expect(aliasCreateManyMock).not.toHaveBeenCalled()
    expect(enqueueSearchOutboxMock).not.toHaveBeenCalled()
    expect(processSubmittedExternalDataMock).not.toHaveBeenCalled()
    expect(queueSearchSyncMock).not.toHaveBeenCalled()
    expect(invalidatePatchContentCacheMock).not.toHaveBeenCalled()
  }

  // 表单打开时的别名是 [别名甲, 别名乙]
  const baseRow = () => ({
    ...makeStoredRow(),
    alias: [{ name: '别名甲' }, { name: '别名乙' }]
  })

  it.each([
    ['名字', { name: '别人改过的名字' }],
    ['介绍', { introduction: '别人改过的游戏介绍文本, 足够长' }],
    ['分级', { content_limit: 'nsfw' }],
    ['发售日期', { released: '2024-01-01' }],
    ['外部 ID', { steam_id: 654321 }],
    ['别名', { alias: [{ name: '别名甲' }] }],
    ['别名顺序', { alias: [{ name: '别名乙' }, { name: '别名甲' }] }]
  ])(
    '表单打开之后%s被别人改过: 回滚并返回冲突提示, 什么都不写',
    async (_, changedByOther) => {
      storedPatchFindUniqueMock.mockResolvedValue({
        ...baseRow(),
        ...changedByOther
      })

      const res = await updateGalgame(
        { ...makeInput(), baseFingerprint: fingerprintOf(baseRow()) },
        1
      )

      expect(res).toBe('该游戏在您打开编辑页之后已被修改, 请刷新后重试')
      expect(lockPatchRowMock).toHaveBeenCalledTimes(1)
      expectNothingWritten()
    }
  )

  // 上一次提交的主事务已落库、后面的标签步骤失败: 用户重试时带的还是旧基线
  it('库里已经是本次提交的值时放行, 重试不会被冲突提示卡住', async () => {
    const input = makeInput()
    storedPatchFindUniqueMock.mockResolvedValue(storedRowAfter(input))

    const res = await updateGalgame(input, 1)

    expect(res).toEqual({})
    expect(committed).toBe(true)
    expect(processSubmittedExternalDataMock).toHaveBeenCalledWith(
      5,
      expect.anything(),
      { removeTagIds: [11], addTagNames: ['标签一'] },
      1
    )
  })

  it('库里是本次提交的值但别名顺序不同: 不是重试, 判冲突', async () => {
    const input = { ...makeInput(), alias: ['别名一', '别名二'] }
    storedPatchFindUniqueMock.mockResolvedValue({
      ...storedRowAfter(input),
      alias: [{ name: '别名二' }, { name: '别名一' }]
    })

    expect(await updateGalgame(input, 1)).toBe(
      '该游戏在您打开编辑页之后已被修改, 请刷新后重试'
    )
    expectNothingWritten()
  })

  it('预检之后、取到行锁之前条目被删: 返回未找到, 什么都不写', async () => {
    storedPatchFindUniqueMock.mockResolvedValue(null)

    expect(await updateGalgame(makeInput(), 1)).toBe(
      '该 ID 下未找到对应 Galgame'
    )
    expectNothingWritten()
  })

  it('别名与 patch 字段在同一个事务里: 换别名失败时字段更新一起回滚', async () => {
    aliasCreateManyMock.mockRejectedValue(new Error('connection lost'))

    await expect(updateGalgame(makeInput(), 1)).rejects.toThrow(
      'connection lost'
    )

    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(patchUpdateMock).toHaveBeenCalledTimes(1)
    expect(aliasDeleteManyMock).toHaveBeenCalledTimes(1)
    expect(committed).toBe(false)
    expect(processSubmittedExternalDataMock).not.toHaveBeenCalled()
  })
})
