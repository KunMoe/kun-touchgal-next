import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { Prisma } from '~/prisma/generated/prisma/client'

const { executeRawMock } = vi.hoisted(() => ({
  executeRawMock: vi.fn()
}))

const transactionClient = {
  $executeRaw: executeRawMock
} as unknown as Prisma.TransactionClient

import {
  recomputePatchRatingStat,
  recomputePatchRatingStats
} from '~/app/api/patch/rating/stat'

expectTypeOf(recomputePatchRatingStat).parameters.toEqualTypeOf<
  [number, Prisma.TransactionClient]
>()

expectTypeOf(recomputePatchRatingStats).parameters.toEqualTypeOf<
  [number[], Prisma.TransactionClient]
>()

const getSql = (call: unknown[]) =>
  (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ').trim()

const getJoinedValues = (call: unknown[]) => {
  const joined = call.find(
    (value): value is { values: unknown[] } =>
      typeof value === 'object' &&
      value !== null &&
      'values' in value &&
      Array.isArray(value.values)
  )
  return joined?.values
}

beforeEach(() => {
  vi.clearAllMocks()
  executeRawMock.mockResolvedValue(1)
})

describe('patch rating statistics', () => {
  it('locks unique patch ids and batch-upserts every rating bucket', async () => {
    await recomputePatchRatingStats([42, 7, 42], transactionClient)

    expect(executeRawMock).toHaveBeenCalledTimes(2)

    const lockCall = executeRawMock.mock.calls[0]
    const lockSql = getSql(lockCall)
    expect(lockSql).toContain('pg_advisory_xact_lock')
    expect(lockSql).toContain('ORDER BY patch_id')
    expect(getJoinedValues(lockCall)).toEqual([7, 42])

    const upsertCall = executeRawMock.mock.calls[1]
    const upsertSql = getSql(upsertCall)
    expect(getJoinedValues(upsertCall)).toEqual([7, 42])
    expect(upsertSql).toContain('INSERT INTO patch_rating_stat')
    expect(upsertSql).toContain('FROM patch AS p')
    expect(upsertSql).toContain('LEFT JOIN patch_rating AS r')
    expect(upsertSql).toContain('r.status = 0')
    expect(upsertSql).toContain('COALESCE(AVG(r.overall), 0)::double precision')
    expect(upsertSql).toContain('COUNT(r.id)::int')
    ;[
      ['strong_no', 'rec_strong_no'],
      ['no', 'rec_no'],
      ['neutral', 'rec_neutral'],
      ['yes', 'rec_yes'],
      ['strong_yes', 'rec_strong_yes']
    ].forEach(([recommend, field]) => {
      expect(upsertSql).toContain(
        `COUNT(r.id) FILTER (WHERE r.recommend = '${recommend}')::int AS ${field}`
      )
    })
    for (let overall = 1; overall <= 10; overall++) {
      expect(upsertSql).toContain(
        `COUNT(r.id) FILTER (WHERE r.overall = ${overall})::int AS o${overall}`
      )
    }
    expect(upsertSql).toContain('ON CONFLICT (patch_id) DO UPDATE')
    expect(upsertSql.match(/statement_timestamp\(\)/g)).toHaveLength(2)
    expect(
      upsertSql.match(/statement_timestamp\(\) AT TIME ZONE 'UTC'/g)
    ).toHaveLength(2)
    expect(upsertSql).not.toContain('NOW()')
  })

  it('waits for the advisory lock before upserting statistics', async () => {
    const lock = Promise.withResolvers<number>()
    executeRawMock.mockImplementationOnce(() => lock.promise)

    const result = recomputePatchRatingStats([42], transactionClient)

    expect(executeRawMock).toHaveBeenCalledTimes(1)

    lock.resolve(1)
    await result

    expect(executeRawMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the single-patch API on the same batch path', async () => {
    await recomputePatchRatingStat(42, transactionClient)

    expect(executeRawMock).toHaveBeenCalledTimes(2)
  })

  it('skips empty batches without executing SQL', async () => {
    await recomputePatchRatingStats([], transactionClient)

    expect(executeRawMock).not.toHaveBeenCalled()
  })
})
