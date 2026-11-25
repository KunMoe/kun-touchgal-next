import { defineScheduledJob } from '~/server/jobs/registry'
import { drainS3DeletionOutbox } from '~/server/storage/s3Outbox'

// drainS3DeletionOutbox 内部已持租约保证单一消费者，无需在此重复加锁。
export const s3DeletionOutboxJob = defineScheduledJob({
  name: 's3_deletion_outbox',
  schedule: '* * * * *',
  run: ({ signal }) => drainS3DeletionOutbox({ signal })
})
