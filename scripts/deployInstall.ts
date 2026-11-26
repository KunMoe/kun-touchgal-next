import 'dotenv/config'
import { execSync } from 'child_process'

const runCommand = (command: string) => {
  try {
    console.log(`Running command: ${command}`)
    execSync(command, { stdio: 'inherit' })
  } catch (error) {
    console.error(`Error running command: ${command}`)
    process.exit(1)
  }
}

runCommand('pnpm install')

// 新环境的入口: 从空库按序建起全部表、触发器与索引 (不分阶段)。由 db push 建起来、
// 还没登记迁移台账的库会被 db:migrate 拒绝, 并提示先盘点登记。
// 已上线的环境不要用这个命令更新依赖: post 迁移会赶在新构建上线之前执行
runCommand('pnpm db:migrate')

// 校验不通过就停下: 新环境的库与迁移 / 快照 / schema 对不上时不该继续往下装
runCommand('pnpm db:verify --prisma')

// 配了搜索引擎密钥才拉起 Meilisearch（幂等），再建索引、下发 settings、对账并在本进程里排空
// (库里有数据时 1.4 万份约 15–30 分钟)。不能只入箱交给 cron：那样索引先以空的样子存在，
// KUN_MEILISEARCH_ENABLED 已打开时查询会从半空的索引召回，也不会降级；未配则保持旧的 Prisma 回退，跳过。
// 搜索为可选特性，任何一步失败仅告警、不阻断安装（runCommand 会 exit(1)，故此处直接用 execSync）
if (process.env.MEILISEARCH_ADMIN_API_KEY) {
  try {
    for (const command of [
      'pnpm search:engine',
      'pnpm search:ensure --apply',
      'pnpm search:reconcile'
    ]) {
      console.log(`Running command: ${command}`)
      execSync(command, { stdio: 'inherit' })
    }
  } catch {
    console.warn(
      '搜索引擎或索引准备失败，已跳过，不影响本次安装。处理后依次重跑 pnpm search:engine、pnpm search:ensure --apply、pnpm search:reconcile；跑完之前保持 KUN_MEILISEARCH_ENABLED=false：索引已建出但文档不全时，查询不会降级到 Prisma 实现'
    )
  }
} else {
  console.log('未配置 MEILISEARCH_ADMIN_API_KEY，跳过搜索引擎启动')
}
