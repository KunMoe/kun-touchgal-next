export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 每进程限制 libvips 每次编码用 1 线程: cluster (16 实例) 下避免 16×核数 过度
    // 订阅, 也让 withEncodeSlot 的并发计数与实际线程占用一致
    const sharp = (await import('sharp')).default
    sharp.concurrency(1)

    if (process.env.KUN_ENABLE_CRON === 'true') {
      const { handleKunJobShutdownSignals, startKunJobs } =
        await import('./server/cron')
      handleKunJobShutdownSignals(await startKunJobs())
    }
  }
}
