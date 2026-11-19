import { prisma } from '~/prisma/index'
import { isPrismaTransactionConflict } from './txErrors'
import { translateDbViolation } from './violations'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { KunViolationMap } from './violations'

// 事务执行器: app / server / lib 下只有这里调用 prisma.$transaction (kun/inv-tx-01)。
// 提交边界归它管: 回调怎样算失败、失败时提不提交、提交之后与没提交时各做什么

// 回调返回值刻意排除 string: prisma.$transaction 的回调 return 字符串等于提交
// (曾造成「已扣分却报错」), 业务失败只能经 ctx.fail 表达
type TxValue = object | number | boolean | bigint | null | undefined | void

// 光有上面的约束挡不住最常见的写法: 成功 return {}、失败 return '消息'。字符串能赋给
// {}, TS 把 '消息' | {} 约简成 {} 后照样通过。所以凡是「字符串也能赋给它」的返回类型
// ({}、unknown、any) 一律拒绝; 没有值可返回的回调就不 return, 由调用方补上 {}
type RejectStringLike<T> = string extends T ? never : T

const committedFailure = Symbol('kunTx.committedFailure')

// 「失败, 但已做的写入要提交」的结果, 只能由 ctx.commitWith 造出来
export interface KunCommittedFailure {
  readonly [committedFailure]: string
}

const isCommittedFailure = (value: unknown): value is KunCommittedFailure =>
  typeof value === 'object' && value !== null && committedFailure in value

export interface KunTxContext {
  readonly tx: Prisma.TransactionClient
  // 回滚本次事务, kunTx 以 message 作为结果返回
  fail(message: string): never
  // 唯一的「失败但提交」写法: 把它的返回值 return 出去, 事务照常提交、提交后副作用照常
  // 执行, kunTx 以 message 作为结果返回。只用于失败分支里有必须落库的写入的场合
  // (资源编辑被拦下时, 已重绑的新对象要随事务入队清理)
  commitWith(message: string): KunCommittedFailure
  // 登记提交后副作用 (缓存失效、通知、出箱 kick 这类可丢失的动作)。同一 key 只登记
  // 一次; 提交后按登记顺序逐个 await, 各自隔离, 失败只记日志、不改变 kunTx 的结果。
  // 必须成功的写入 (审计日志等) 留在事务内
  afterCommit(key: string, effect: () => unknown): void
  // 登记「最终没有提交」时的清理, 用于回调里才产生的库外产物 (事务内上传的对象)。
  // fail、violations 翻译、其它异常、重试耗尽、commit 抛错 (结果不确定) 都算没有提交;
  // 中途被重放的尝试不触发, 各次尝试登记的都留到结果确定, 同一 key 只执行一次。
  // 做了库外 I/O 的回调不要开 retry: 重放后提交的话, 上一轮的产物没有人清理
  onRollback(key: string, effect: () => unknown): void
}

export interface KunTxOptions {
  // 只对事务冲突 (P2034 / 40001 / 40P01) 重放, 默认不重试
  retry?: number
  timeout?: number
  maxWait?: number
  isolationLevel?: Prisma.TransactionIsolationLevel
  // 逐站点的违例文案: 回滚之后把表里列出的违例翻成 kunTx 的结果; 没列出的原样抛出,
  // 由 kunRoute 在路由边界做通用兜底
  violations?: KunViolationMap
  // 与 ctx.onRollback 同义, 用于事务开始之前就已存在的库外产物 (已绑定的 S3 对象):
  // 事务可能连开都没开起来 (拿不到连接), 那时回调没有执行, ctx.onRollback 登记不上
  onRollback?: () => unknown
}

class KunTxAbort extends Error {}

const waitBeforeRetry = () =>
  new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 75))

// commitWith 的结果是对象, 本来就在 T 的范围内: 回调可以把它与成功值混着返回, 交给调用方
// 之前换成它带的消息, 所以结果类型里把它从 T 中去掉
export const kunTx = async <T extends TxValue>(
  name: string,
  body: (ctx: KunTxContext) => Promise<RejectStringLike<T>>,
  options: KunTxOptions = {}
): Promise<Exclude<T, KunCommittedFailure> | string> => {
  const { retry = 0, violations, onRollback, ...transactionOptions } = options
  const hasTransactionOptions = Object.keys(transactionOptions).length > 0

  // 副作用逐项隔离: 一项失败只记日志, 不影响其余各项, 也不改变 kunTx 的结果
  const settle = async (label: string, effect: () => unknown) => {
    try {
      await effect()
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[kunTx:${name}] ${label}`, error)
    }
  }

  const rollbackEffects = new Map<string, () => unknown>()

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
        commitWith: (message) => ({ [committedFailure]: message }),
        afterCommit(key, effect) {
          if (!effects.has(key)) {
            effects.set(key, effect)
          }
        },
        onRollback(key, effect) {
          if (!rollbackEffects.has(key)) {
            rollbackEffects.set(key, effect)
          }
        }
      })
      // body 里的 try/catch 可能把 fail 抛出的中止吞掉: 提交前再查一次, 否则失败会被提交
      if (abort) {
        throw abort
      }
      // 类型挡不住的写法 (返回类型标成 void 的函数实际返回了字符串、as 断言) 在这里兜住:
      // 放它过去就是带着已做的写入提交, 调用方却把结果当成失败
      if (typeof result === 'string') {
        throw new TypeError(
          `[kunTx:${name}] 回调返回了字符串, 业务失败要用 ctx.fail`
        )
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
      if (attempt < retry && isPrismaTransactionConflict(error)) {
        await waitBeforeRetry()
        continue
      }

      // 结果已定: 没有提交。先清理, 再决定以什么形式交给调用方
      if (onRollback) {
        await settle('onRollback', onRollback)
      }
      for (const [key, effect] of rollbackEffects) {
        await settle(`onRollback:${key}`, effect)
      }
      if (error instanceof KunTxAbort) {
        return error.message
      }
      const violation = violations && translateDbViolation(error, violations)
      if (violation !== undefined) {
        return violation
      }
      throw error
    }

    for (const [key, effect] of effects) {
      await settle(key, effect)
    }
    return isCommittedFailure(value)
      ? value[committedFailure]
      : (value as Exclude<T, KunCommittedFailure>)
  }
}
