const path = require('path')

const cwd = path.join(__dirname)
const standaloneServer = './.next/standalone/server.js'
const commonEnv = {
  NODE_ENV: 'production',
  HOSTNAME: '127.0.0.1',
  // 抬高 libuv 线程池 (默认 4): 编码占槽时给同池的 fs / dns.lookup 留余量
  UV_THREADPOOL_SIZE: '8'
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
