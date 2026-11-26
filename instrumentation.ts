import type { Instrumentation } from 'next'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 每进程限制 libvips 每次编码用 1 线程: cluster (16 实例) 下避免 16×核数 过度
    // 订阅, 也让 withEncodeSlot 的并发计数与实际线程占用一致
    const sharp = (await import('sharp')).default
    sharp.concurrency(1)

    // Next 已注册只记录、不退出的同类监听 (process-error-handlers.js), 这里只补一行带上下文的
    // 结构化日志。异常用 uncaughtExceptionMonitor: 只观察, 不改变进程对异常的处置
    const { kunLog } = await import('./lib/log.server')
    process.on('unhandledRejection', (reason) => {
      kunLog('process.unhandled', { kind: 'unhandledRejection' }, reason)
    })
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      kunLog('process.unhandled', { kind: origin }, error)
    })

    if (process.env.KUN_ENABLE_CRON === 'true') {
      const { handleKunJobShutdownSignals, startKunJobs } =
        await import('./server/cron')
      handleKunJobShutdownSignals(await startKunJobs())
    }
  }
}

// Next 在这个钩子之后仍会打印自己那份不带时间与路由的堆栈 (关不掉)。这一行自带堆栈: Route
// Handler 的错误没有 digest, 16 个实例的日志合并后, 只有上下文的一行与那份裸堆栈对不上。
// 只读 x-request-id 一个请求头 (其余含会话 cookie), path 去掉 query (撤销链接把令牌放在 query
// 里); 只做同步写, 不做网络 I/O
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context
) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return
  }
  const { kunLog } = await import('./lib/log.server')
  const requestId = request.headers['x-request-id']
  const digest =
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof error.digest === 'string'
      ? error.digest
      : undefined
  kunLog(
    'request.unhandled',
    {
      path: request.path.split('?')[0],
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
      revalidateReason: context.revalidateReason,
      digest,
      requestId: Array.isArray(requestId) ? requestId[0] : requestId
    },
    error
  )
}
