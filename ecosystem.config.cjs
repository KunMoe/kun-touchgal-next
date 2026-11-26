const path = require('path')

const cwd = path.join(__dirname)
const standaloneServer = './.next/standalone/server.js'
const commonEnv = {
  NODE_ENV: 'production',
  HOSTNAME: '127.0.0.1',
  // 抬高 libuv 线程池 (默认 4): 编码占槽时给同池的 fs / dns.lookup 留余量
  UV_THREADPOOL_SIZE: '8'
}
// 不按实例号拆日志文件: 16 个 cluster 实例并进同一个 out / error 文件。kunLog 的行本身就是带 ts 的
// JSON, 不开 log_type: 'json' (会双重编码)。体积上限交给主机上的 pm2-logrotate
const mergedLogs = { merge_logs: true }
// 时间前缀 (「2026-11-26T10:41:46.407+08:00: 」) 只给 cluster 模式的 web: 那里 pm2 按每次 write
// 加一个前缀, 给 Next 自己打印的裸堆栈补上时间 (多行的只有首行带)。fork 模式的 cron 不加: pm2
// 6.0.14 在那里按管道分块切行 (lib/God/ForkMode.js 的 prefixLogWithDate), 一块在行中间断开时
// 尾巴被直接丢掉, 突发的日志 (出箱逐行失败) 会丢行
const webLogs = {
  ...mergedLogs,
  log_date_format: 'YYYY-MM-DDTHH:mm:ss.SSSZ'
}

module.exports = {
  apps: [
    {
      name: 'kun-touchgal-next',
      port: 3000,
      cwd,
      instances: 16,
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      script: standaloneServer,
      ...webLogs,
      // https://nextjs.org/docs/pages/api-reference/config/next-config-js/output
      env: {
        ...commonEnv,
        PORT: 3000,
        KUN_ENABLE_CRON: 'false'
      }
    },
    {
      name: 'kun-touchgal-next-cron',
      port: 3001,
      cwd,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      script: standaloneServer,
      ...mergedLogs,
      // PM2 停进程先发 SIGINT, 这么久还没退出才 SIGKILL (默认 1.6 秒)。须大于作业关停的宽限期
      // 加收尾 (server/cron.ts 的 KUN_JOB_SHUTDOWN_GRACE_MS)
      kill_timeout: 30000,
      env: {
        ...commonEnv,
        PORT: 3001,
        KUN_ENABLE_CRON: 'true',
        // 信号交给作业层 (server/cron.ts): 不设的话 Next 收到信号关掉 HTTP 就直接退出, 在途
        // 作业被当成崩溃。只能加在 cron 进程上: web 进程设了它, 收到信号时不会先关 HTTP
        NEXT_MANUAL_SIG_HANDLE: 'true'
      }
    }
  ]
}
