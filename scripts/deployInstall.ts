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

runCommand('pnpm prisma:push')

// 配了搜索引擎密钥才拉起 Meilisearch（幂等）；未配则保持旧的 Prisma 回退，跳过。
// 搜索为可选特性，引擎起不来仅告警、不阻断安装（runCommand 会 exit(1)，故此处直接用 execSync）
if (process.env.MEILISEARCH_ADMIN_API_KEY) {
  try {
    console.log('Running command: pnpm search:engine')
    execSync('pnpm search:engine', { stdio: 'inherit' })
  } catch {
    console.warn(
      '搜索引擎启动失败，已跳过；搜索将回退 Prisma 实现，不影响本次安装'
    )
  }
} else {
  console.log('未配置 MEILISEARCH_ADMIN_API_KEY，跳过搜索引擎启动')
}
