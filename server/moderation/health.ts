import * as z from 'zod'
import { KUN_MODERATION_HEALTH_KEY } from '~/config/redis'
import { getKv, setKv } from '~/lib/redis'

// 审核 worker 的车道状态: cron 进程每批上报一次 (批次进行中另有心跳), web 进程只读。
// 键的形状只在这里定。键带 TTL: 读不到说明 cron 进程超过两分钟没有上报

const HEALTH_TTL_SECONDS = 120

const laneSnapshotSchema = z.object({
  state: z.enum(['closed', 'open', 'half_open']),
  reason: z
    .enum(['dependency', 'rate_limited', 'misconfigured', 'systematic'])
    .nullable(),
  since: z.number().nullable(),
  openUntil: z.number().nullable(),
  opens: z.number(),
  lastError: z.string()
})

const healthSchema = z.object({
  // 上报时刻 (毫秒)
  at: z.number(),
  lanes: z.object({ text: laneSnapshotSchema, avatar: laneSnapshotSchema })
})

export type ModerationHealth = z.infer<typeof healthSchema>

// 上报失败不影响审核本身
export const publishModerationHealth = async (health: ModerationHealth) => {
  try {
    await setKv(
      KUN_MODERATION_HEALTH_KEY,
      JSON.stringify(health),
      HEALTH_TTL_SECONDS
    )
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to publish moderation health:', error)
  }
}

// 没有上报、读不到或形状对不上 (新旧版本交替) 都是 null: 管理端显示为状态未知
export const readModerationHealth =
  async (): Promise<ModerationHealth | null> => {
    try {
      const raw = await getKv(KUN_MODERATION_HEALTH_KEY)
      if (!raw) {
        return null
      }
      const parsed = healthSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
