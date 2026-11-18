import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, countMock, executeRawMock, headObjectMock } = vi.hoisted(
  () => ({
    findManyMock: vi.fn(),
    countMock: vi.fn(),
    executeRawMock: vi.fn(),
    headObjectMock: vi.fn()
  })
)

vi.mock('~/prisma/index', () => ({
  prisma: {
    $executeRaw: executeRawMock,
    patch_resource_link: { findMany: findManyMock, count: countMock }
  }
}))
vi.mock('~/lib/s3', () => ({ headObject: headObjectMock }))
vi.mock('~/lib/redis', () => ({}))

import {
  backfillResourceLinkS3Key as backfillRun,
  classifyLegacyLink
} from '~/migration/backfillResourceLinkS3Key'
import type { ReportRow } from '~/migration/backfillResourceLinkS3Key'

// 报告逐行交给 onRow; 收集起来与汇总一起断言
const backfillResourceLinkS3Key = async ({ write }: { write: boolean }) => {
  const report: ReportRow[] = []
  const summary = await backfillRun({
    write,
    onRow: (row) => report.push(row)
  })
  return { ...summary, report }
}

const URL = 'https://cloud.example.test'

const notFound = () =>
  Object.assign(new Error('NotFound'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 }
  })

const link = (
  id: number,
  content: string,
  options: { hash?: string; patchId?: number } = {}
) => ({
  id,
  content,
  hash: options.hash ?? 'h',
  resource_id: id * 10,
  resource: { patch_id: options.patchId ?? 1 }
})

// existing: 桶里存在的对象 key
const seed = (links: ReturnType<typeof link>[], existing: string[]) => {
  findManyMock.mockResolvedValue(links)
  headObjectMock.mockImplementation(async (key: string) => {
    if (!existing.includes(key)) {
      throw notFound()
    }
    return {}
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  countMock.mockResolvedValue(0)
  executeRawMock.mockResolvedValue(1)
})

describe('classifyLegacyLink', () => {
  const tail = 'patch/1/resource/h/f.zip'
  const other = 'patch/2/resource/h/f.zip'

  it.each([
    [
      '两式一致且存在',
      { tailKey: tail, tailExists: true, resolvedKey: tail },
      { category: 'consistent', key: tail }
    ],
    [
      '两式一致但不存在: 死链照样写尾段',
      { tailKey: tail, tailExists: false, resolvedKey: tail },
      { category: 'missing', key: tail }
    ],
    [
      '两式不一致、两个都在: 写尾段',
      {
        tailKey: tail,
        tailExists: true,
        resolvedKey: other,
        resolvedExists: true
      },
      { category: 'divergent', key: tail }
    ],
    [
      '只有尾段的对象在',
      {
        tailKey: tail,
        tailExists: true,
        resolvedKey: other,
        resolvedExists: false
      },
      { category: 'single', key: tail }
    ],
    [
      '只有另一式的对象在: 写真实存在的那个',
      {
        tailKey: tail,
        tailExists: false,
        resolvedKey: other,
        resolvedExists: true
      },
      { category: 'single', key: other }
    ],
    [
      '两式不一致、都不在: 写尾段',
      {
        tailKey: tail,
        tailExists: false,
        resolvedKey: other,
        resolvedExists: false
      },
      { category: 'missing', key: tail }
    ],
    [
      '没有尾段, 另一式的对象在',
      { tailKey: null, resolvedKey: other, resolvedExists: true },
      { category: 'single', key: other }
    ],
    [
      '没有尾段, 另一式也不在',
      { tailKey: null, resolvedKey: other, resolvedExists: false },
      { category: 'missing', key: other }
    ],
    [
      '两式都算不出',
      { tailKey: null, resolvedKey: null },
      { category: 'unresolvable', key: null }
    ]
  ])('%s', (_name, input, expected) => {
    expect(
      classifyLegacyLink({
        tailExists: false,
        resolvedExists: false,
        ...input
      })
    ).toEqual(expected)
  })
})

describe('backfillResourceLinkS3Key', () => {
  it('dry-run 只 HeadObject 与分类, 不写库', async () => {
    seed(
      [link(1, `${URL}/patch/1/resource/h/f.zip`)],
      ['patch/1/resource/h/f.zip']
    )
    countMock.mockResolvedValue(1)

    const result = await backfillResourceLinkS3Key({ write: false })

    expect(executeRawMock).not.toHaveBeenCalled()
    expect(result.categories).toEqual({ consistent: 1 })
    expect(result.results).toEqual({ 'dry-run': 1 })
    expect(result.remaining).toBe(1)
    // 只读 s3_key 为空的 s3 行
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storage: 's3', s3_key: '' } })
    )
  })

  it('--write 以「仍是空 s3_key、content 未变」为条件写入, 没写成的记为 conflict', async () => {
    seed(
      [
        link(1, `${URL}/patch/1/resource/h/f.zip`),
        link(2, `${URL}/patch/1/resource/h/g.zip`)
      ],
      ['patch/1/resource/h/f.zip', 'patch/1/resource/h/g.zip']
    )
    executeRawMock.mockResolvedValueOnce(1).mockResolvedValueOnce(0)

    const result = await backfillResourceLinkS3Key({ write: true })

    expect(executeRawMock).toHaveBeenCalledTimes(2)
    const [strings, ...values] = executeRawMock.mock.calls[0]
    expect((strings as string[]).join('?').replace(/\s+/g, ' ').trim()).toBe(
      "UPDATE patch_resource_link SET s3_key = ? WHERE id = ? AND storage = 's3' AND s3_key = '' AND content = ?"
    )
    expect(values).toEqual([
      'patch/1/resource/h/f.zip',
      1,
      `${URL}/patch/1/resource/h/f.zip`
    ])
    expect(result.results).toEqual({ written: 1, conflict: 1 })
  })

  it('hash 被写空、旧代码写进别的游戏前缀: 写下载地址指向的那个对象', async () => {
    // 行属于 patch 7, 对象在 patch/8; resolveS3Key 按 patch 7 与空 hash 算出另一个 key
    seed(
      [link(1, `${URL}/patch/8/resource/h/f.zip`, { hash: '', patchId: 7 })],
      ['patch/8/resource/h/f.zip']
    )

    const result = await backfillResourceLinkS3Key({ write: true })

    expect(executeRawMock.mock.calls[0][1]).toBe('patch/8/resource/h/f.zip')
    expect(result.report[0]).toMatchObject({
      category: 'single',
      resolved_key: 'patch/7/resource//f.zip',
      resolved_exists: false
    })
  })

  it('共享同一对象的几条链接: 都写同一个 key, 报告带 group_size, 同一 key 只 HeadObject 一次', async () => {
    seed(
      [
        link(1, `${URL}/patch/1/resource/h/f.zip`),
        link(2, `${URL}/patch/1/resource/h/f.zip`),
        link(3, `${URL}/patch/1/resource/h/other.zip`)
      ],
      []
    )

    const result = await backfillResourceLinkS3Key({ write: true })

    expect(headObjectMock).toHaveBeenCalledTimes(2)
    expect(result.report.map((row) => [row.link_id, row.group_size])).toEqual([
      [1, 2],
      [2, 2],
      [3, 1]
    ])
    expect(result.categories).toEqual({ missing: 3 })
  })

  it('两式都算不出的行不写', async () => {
    seed([link(1, '')], [])

    const result = await backfillResourceLinkS3Key({ write: true })

    expect(executeRawMock).not.toHaveBeenCalled()
    expect(result.results).toEqual({ skipped: 1 })
  })

  it('中途中止时, 已处理 (已写库) 的行已经交给报告', async () => {
    seed(
      [
        link(1, `${URL}/patch/1/resource/h/f.zip`),
        link(2, `${URL}/patch/1/resource/h/g.zip`)
      ],
      ['patch/1/resource/h/f.zip']
    )
    headObjectMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error('timeout'), { name: 'TimeoutError' })
      )
    const rows: ReportRow[] = []

    await expect(
      backfillRun({ write: true, onRow: (row) => rows.push(row) })
    ).rejects.toThrow(/HeadObject patch\/1\/resource\/h\/g\.zip 失败/)
    expect(executeRawMock).toHaveBeenCalledTimes(1)
    expect(rows).toEqual([
      expect.objectContaining({ link_id: 1, result: 'written' })
    ])
  })

  it('HeadObject 除 404 以外的错误直接中止, 不当成「不存在」', async () => {
    seed([link(1, `${URL}/patch/1/resource/h/f.zip`)], [])
    headObjectMock.mockRejectedValue(
      Object.assign(new Error('Forbidden'), {
        name: 'Forbidden',
        $metadata: { httpStatusCode: 403 }
      })
    )

    await expect(backfillResourceLinkS3Key({ write: true })).rejects.toThrow(
      /HeadObject patch\/1\/resource\/h\/f\.zip 失败/
    )
    expect(executeRawMock).not.toHaveBeenCalled()
  })
})
