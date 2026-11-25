import { describe, expect, it, vi } from 'vitest'

vi.mock('~/server/search/reconcile', () => ({ reconcileSearchIndex: vi.fn() }))
vi.mock('~/lib/meilisearch', () => ({ getMeiliClient: () => null }))

import { DEFAULT_LEASE_STALL_MS } from '~/server/jobs/lease'
import { searchReconcileJob } from '~/server/tasks/searchReconcileTask'

describe('searchReconcileJob', () => {
  // 整次检测是一个工作单元、中间不报进度: 用默认的停滞上限, 一次跑得久的对账会被当成卡住,
  // 租约被放掉还记一条 error
  it('持对账的租约, 停滞上限放宽到一小时 (改造前这把锁的寿命)', () => {
    expect(searchReconcileJob.lease).toEqual({
      key: 'search:reconcile:lock',
      stallMs: 60 * 60 * 1000
    })
    expect(searchReconcileJob.lease!.stallMs!).toBeGreaterThan(
      DEFAULT_LEASE_STALL_MS
    )
  })
})
