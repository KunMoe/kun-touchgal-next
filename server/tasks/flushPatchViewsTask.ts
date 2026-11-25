import { Prisma } from '~/prisma/generated/prisma/client'
import { prisma } from '~/prisma'
import {
  acknowledgePatchViewBuffer,
  acknowledgePatchViewBufferEntries,
  checkoutPatchViewBuffer
} from '~/app/api/patch/views/buffer'
import { defineScheduledJob } from '~/server/jobs/registry'

const FLUSH_BATCH_SIZE = 1000

// signal 中止 (关停、租约丢失) 时停在两批之间: 已落库的批已确认, 没落的留在缓冲里等下一轮。
// 租约丢失后不再落下一批, 是为了不与接手的进程重复计入同一批
export const flushPatchViews = async (signal?: AbortSignal) => {
  const buffer = await checkoutPatchViewBuffer()
  if (!buffer) {
    return
  }

  const validEntries = Object.entries(buffer.entries)
    .map(([uniqueId, countStr]) => [uniqueId, Number(countStr)] as const)
    .filter(([, count]) => Number.isFinite(count) && count > 0)

  if (validEntries.length === 0) {
    await acknowledgePatchViewBuffer(buffer.key)
    return
  }

  for (let i = 0; i < validEntries.length; i += FLUSH_BATCH_SIZE) {
    signal?.throwIfAborted()
    const batch = validEntries.slice(i, i + FLUSH_BATCH_SIZE)
    const caseFragments = batch.map(
      ([uniqueId, count]) => Prisma.sql`WHEN ${uniqueId} THEN ${count}`
    )
    const uniqueIdList = batch.map(([uniqueId]) => uniqueId)

    await prisma.$executeRaw`
        UPDATE patch
        SET view = view + CASE unique_id
          ${Prisma.join(caseFragments, ' ')}
          ELSE 0
        END
        WHERE unique_id IN (${Prisma.join(uniqueIdList)})
      `

    await acknowledgePatchViewBufferEntries(buffer.key, uniqueIdList)
  }

  await acknowledgePatchViewBuffer(buffer.key)
}

export const flushPatchViewsJob = defineScheduledJob({
  name: 'flush_patch_views',
  schedule: '*/2 * * * *',
  lease: { key: 'patch:views:flush:lock' },
  run: ({ signal }) => flushPatchViews(signal)
})
