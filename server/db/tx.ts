import { prisma } from '~/prisma/index'
import type { Prisma } from '~/prisma/generated/prisma/client'
import { isPrismaTransactionConflict } from './txErrors'

// 事务执行器。T01 自带的最小实现, 签名取自 T13 裁决 (server/db/tx.ts), 供
// server/content 的命令使用; 其余 $transaction 不迁移。T13 的 commitWith / onRollback /
// violations 都是对本接口的追加, 落地时在本文件原地接管

// 回调返回值刻意排除 string: prisma.$transaction 的回调 return 字符串等于提交
// (曾造成「已扣分却报错」), 业务失败只能经 ctx.fail 表达
type TxValue = object | number | boolean | bigint | null | undefined | void

export interface KunTxContext {
  readonly tx: Prisma.TransactionClient
  // 回滚本次事务, kunTx 以 message 作为结果返回
  fail(message: string): never
  // 登记提交后副作用 (缓存失效、通知、出箱 kick 这类可丢失的动作)。同一 key 只登记
  // 一次; 提交后按登记顺序逐个 await, 各自隔离, 失败只记日志、不改变 kunTx 的结果。
  // 必须成功的写入 (审计日志等) 留在事务内
  afterCommit(key: string, effect: () => unknown): void
}

export interface KunTxOptions {
  // 只对事务冲突 (P2034 / 40001 / 40P01) 重放, 默认不重试
  retry?: number
  timeout?: number
  maxWait?: number
  isolationLevel?: Prisma.TransactionIsolationLevel
}

class KunTxAbort extends Error {}

const waitBeforeRetry = () =>
  new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 75))

export const kunTx = async <T extends TxValue>(
  name: string,
  body: (ctx: KunTxContext) => Promise<T>,
  options: KunTxOptions = {}
): Promise<T | string> => {
  const { retry = 0, ...transactionOptions } = options
  const hasTransactionOptions = Object.keys(transactionOptions).length > 0

  for (let attempt = 0; ; attempt++) {
    // 每次尝试各用一个队列: 被回滚的尝试登记过的副作用不能带到下一轮的提交之后
    const effects = new Map<string, () => unknown>()
    let abort: KunTxAbort | null = null

    const run = async (tx: Prisma.TransactionClient) => {
      const result = await body({
        tx,
        fail(message) {
          abort = new KunTxAbort(message)
          throw abort
        },
        afterCommit(key, effect) {
          if (!effects.has(key)) {
            effects.set(key, effect)
          }
        }
      })
      // body 里的 try/catch 可能把 fail 抛出的中止吞掉: 提交前再查一次, 否则失败会被提交
      if (abort) {
        throw abort
      }
      return result
    }

    let value: T
    try {
      // 没给事务选项时只传一个参数, 与直接调用 $transaction 的形状一致
      value = hasTransactionOptions
        ? await prisma.$transaction(run, transactionOptions)
        : await prisma.$transaction(run)
    } catch (error) {
      if (error instanceof KunTxAbort) {
        return error.message
      }
      if (attempt < retry && isPrismaTransactionConflict(error)) {
        await waitBeforeRetry()
        continue
      }
      throw error
    }

    for (const [key, effect] of effects) {
      try {
        await effect()
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[kunTx:${name}] ${key}`, error)
      }
    }
    return value
  }
}
