const path = require('path')

const cwd = path.join(__dirname)
const standaloneServer = './.next/standalone/server.js'
const commonEnv = {
  NODE_ENV: 'production',
  HOSTNAME: '127.0.0.1',
  // 抬高 libuv 线程池 (默认 4): 编码占槽时给同池的 fs / dns.lookup 留余量
  UV_THREADPOOL_SIZE: '8'
}
// 16 个 cluster 实例并进同一个 out / error 文件 (不设时按实例号拆成多份), 每行加毫秒级 ISO 时间前缀
// (「2026-11-26T10:41:46.407+08:00: 」): Next 自己打印的裸堆栈、ioredis 这类不经 kunLog 的输出
// 也有了时间。kunLog 的行本身就是带 ts 的 JSON, 不再开 log_type: 'json' (会双重编码)。
// pm2 6.0.14 实测; 体积上限交给主机上的 pm2-logrotate
const commonLogs = {
  merge_logs: true,
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
      ...commonLogs,
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
      ...commonLogs,
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
