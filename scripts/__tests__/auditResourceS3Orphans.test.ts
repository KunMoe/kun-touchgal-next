import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock, isReferencedMock, outboxFindUniqueMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  isReferencedMock: vi.fn(),
  outboxFindUniqueMock: vi.fn()
}))

vi.mock('~/lib/s3', () => ({ s3: { send: sendMock } }))
vi.mock('~/server/storage/references', () => ({
  isS3ObjectReferenced: isReferencedMock
}))
vi.mock('~/prisma/index', () => ({
  prisma: { s3_deletion_outbox: { findUnique: outboxFindUniqueMock } }
}))

import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import { auditResourceS3Orphans } from '~/scripts/auditResourceS3Orphans'

const NOW = Date.parse('2026-11-19T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const object = (Key: string, ageMs: number, Size = 100) => ({
  Key,
  Size,
  LastModified: new Date(NOW - ageMs)
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  isReferencedMock.mockResolvedValue(false)
  outboxFindUniqueMock.mockResolvedValue(null)
})

const audit = async () => {
  const lines: string[] = []
  const summary = await auditResourceS3Orphans({
    emit: (line) => lines.push(line),
    now: NOW
  })
  return { lines, summary }
}

describe('auditResourceS3Orphans', () => {
  it('只输出资源正式前缀下、48 小时前的、无引用的对象, 翻完所有分页', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [
          object('patch/1/resource/a/orphan.zip', 3 * DAY, 2048),
          object('patch/1/resource/a/used.zip', 3 * DAY),
          object('patch/1/banner/banner.avif', 3 * DAY),
          object('patch/tmp/7/s/upload.zip', 3 * DAY)
        ],
        IsTruncated: true,
        NextContinuationToken: 'next'
      })
      .mockResolvedValueOnce({
        Contents: [
          object('patch/2/resource/b/fresh.zip', DAY),
          object('patch/2/resource/b/queued.zip', 5 * DAY, 10)
        ],
        IsTruncated: false
      })
    isReferencedMock.mockImplementation(
      async (_db: unknown, key: string) => key === 'patch/1/resource/a/used.zip'
    )
    outboxFindUniqueMock.mockImplementation(
      async (args: { where: { s3_key: string } }) =>
        args.where.s3_key === 'patch/2/resource/b/queued.zip'
          ? { s3_key: args.where.s3_key }
          : null
    )

    const { lines, summary } = await audit()

    expect(lines).toEqual([
      'key,size_bytes,last_modified,in_outbox',
      `"patch/1/resource/a/orphan.zip","2048","${new Date(NOW - 3 * DAY).toISOString()}","false"`,
      `"patch/2/resource/b/queued.zip","10","${new Date(NOW - 5 * DAY).toISOString()}","true"`
    ])
    expect(summary).toEqual({
      listed: 6,
      resourceObjects: 4,
      tooRecent: 1,
      referenced: 1,
      orphans: 2,
      orphanBytes: 2058,
      orphansInOutbox: 1
    })
    // 第二页带上一页的续传令牌
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(sendMock.mock.calls[1][0].input).toMatchObject({
      Prefix: 'patch/',
      ContinuationToken: 'next'
    })
  })

  it('只读: 对桶只发 ListObjectsV2', async () => {
    sendMock.mockResolvedValue({
      Contents: [object('patch/1/resource/a/orphan.zip', 3 * DAY)],
      IsTruncated: false
    })

    await audit()

    for (const [command] of sendMock.mock.calls) {
      expect(command).toBeInstanceOf(ListObjectsV2Command)
    }
  })
})
