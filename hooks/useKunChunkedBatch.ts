import { useRef, useState } from 'react'
import {
  kunMergeChunkResults,
  kunPlanChunks,
  type KunChunkOutcome,
  type KunChunkedBatchResult
} from '~/utils/list/kunChunkedBatch'

// 分块批量操作: 串行发送, 块与块之间可以停止 (P22-01)。约定: 运行期间确认弹窗不可被遮罩、ESC
// 或右上角关闭 (isDismissable={false}、isKeyboardDismissDisabled、hideCloseButton),
// 「取消」换成调用 stop 的「停止剩余」; 结束后宿主调列表的 refresh
export const useKunChunkedBatch = ({
  chunkSize,
  send
}: {
  chunkSize: number
  // 数字是服务端确认成功的条数, 字符串是失败原因
  send: (chunk: number[]) => Promise<KunChunkOutcome>
}) => {
  const [progress, setProgress] = useState<{
    sent: number
    total: number
  } | null>(null)
  const [isStopping, setIsStopping] = useState(false)
  const stopRef = useRef(false)

  const run = async (
    ids: readonly number[]
  ): Promise<KunChunkedBatchResult> => {
    stopRef.current = false
    setIsStopping(false)
    const chunks = kunPlanChunks(ids, chunkSize)
    const outcomes: KunChunkOutcome[] = []
    try {
      for (const [index, chunk] of chunks.entries()) {
        if (stopRef.current) {
          break
        }
        setProgress({
          sent: Math.min((index + 1) * chunkSize, ids.length),
          total: ids.length
        })
        outcomes.push(
          await send(chunk).catch((error: unknown) =>
            error instanceof Error ? error.message : '发生未知错误'
          )
        )
      }
    } finally {
      setProgress(null)
      setIsStopping(false)
    }
    return kunMergeChunkResults(chunks, outcomes)
  }

  // 正在发的那一块照常完成, 其余不再发出
  const stop = () => {
    stopRef.current = true
    setIsStopping(true)
  }

  return { run, stop, isRunning: progress !== null, isStopping, progress }
}
