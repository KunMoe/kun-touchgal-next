import { existsSync } from 'fs'

// robots.txt 由 app/robots.ts 输出。public 下的同名文件会先于路由被返回, next build 不报
// 这种冲突。留着就是悄悄用一份过期的文件顶替路由, 所以不开始构建
const stale = ['public/robots.txt'].filter((file) => existsSync(file))

if (stale.length > 0) {
  throw new Error(
    `${stale.join('、')} 会顶替 app 下同名的路由。删除后重新执行刚才的命令 (线上是 pnpm deploy:build)`
  )
}
