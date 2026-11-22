// 分块批量操作的计划与结果归并 (T17)。块按顺序串行发送 (避免同一 patch 的删除事务在通告锁上
// 排队占满连接池), 块与块之间可以停止: 停止时正在发的那一块照常完成, 其余记为 notRun。
// hooks/useKunChunkedBatch.ts 负责发送与停止, 判断都在这里

// 一块的结果: 数字是服务端确认成功的条数, 字符串是这一块失败的原因
export type KunChunkOutcome = number | string

export interface KunChunkedBatchResult {
  succeeded: number
  failed: number[]
  notRun: number[]
  messages: string[]
}

// 块大小不得超过后端单次上限, 否则整块被校验拒绝
export const kunPlanChunks = (ids: readonly number[], size: number) => {
  const chunks: number[][] = []
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size))
  }
  return chunks
}

// outcomes 按块的顺序给出, 比 chunks 短的部分是被停止、没有发出的块
export const kunMergeChunkResults = (
  chunks: readonly (readonly number[])[],
  outcomes: readonly KunChunkOutcome[]
): KunChunkedBatchResult => {
  const result: KunChunkedBatchResult = {
    succeeded: 0,
    failed: [],
    notRun: [],
    messages: []
  }
  chunks.forEach((chunk, index) => {
    if (index >= outcomes.length) {
      result.notRun.push(...chunk)
      return
    }
    const outcome = outcomes[index]
    if (typeof outcome === 'string') {
      result.failed.push(...chunk)
      result.messages.push(outcome)
    } else {
      result.succeeded += outcome
    }
  })
  return result
}

// 没有全部完成时的提示: 失败与被停止的都留在选中集里, 可以直接再点一次
export const kunDescribeBatchShortfall = (
  { succeeded, failed, notRun }: KunChunkedBatchResult,
  verb: string
) =>
  [
    `已${verb} ${succeeded} 条`,
    failed.length ? `${failed.length} 条${verb}失败` : '',
    notRun.length ? `已停止, 剩余 ${notRun.length} 条未${verb}` : '',
    '已保留选中可重试'
  ]
    .filter(Boolean)
    .join(', ')
