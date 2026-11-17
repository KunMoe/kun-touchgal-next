/* eslint-disable no-console */
import '../validations/dotenv-check'
import { execSync } from 'child_process'
import { existsSync, renameSync, rmSync } from 'fs'
import { kunReportDeployChain, kunRunDeployChain } from './deployChain'

const activeDistDir = '.next'
const stagedDistDir = '.next-deploy'
const previousDistDir = '.next-previous'
const appNames = ['kun-touchgal-next', 'kun-touchgal-next-cron']

const runCommand = (command: string, env: NodeJS.ProcessEnv = process.env) => {
  execSync(command, { stdio: 'inherit', env })
}

// 取回标准输出供部署链判断, 同时照常打印, 部署日志里不缺这一段
const captureCommand = (command: string) => {
  const output = execSync(command, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit']
  })
  process.stdout.write(output)
  return output
}

const isApplicationRunning = () =>
  appNames.some((appName) =>
    execSync(`pm2 pid ${appName}`, { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .some((pid) => Number(pid) > 0)
  )

const activateStagedBuild = () => {
  const wasRunning = isApplicationRunning()
  if (wasRunning) {
    runCommand('pnpm stop')
  }

  rmSync(previousDistDir, { recursive: true, force: true })
  const hadActiveBuild = existsSync(activeDistDir)
  if (hadActiveBuild) {
    renameSync(activeDistDir, previousDistDir)
  }

  try {
    renameSync(stagedDistDir, activeDistDir)
    runCommand('pnpm start')
  } catch (error) {
    if (isApplicationRunning()) {
      runCommand('pnpm stop')
    }
    rmSync(activeDistDir, { recursive: true, force: true })
    if (hadActiveBuild) {
      renameSync(previousDistDir, activeDistDir)
    }
    if (wasRunning) {
      runCommand('pnpm start')
    }
    throw error
  }

  rmSync(previousDistDir, { recursive: true, force: true })
}

console.log('Environment variables are valid.')
console.log('Executing the commands...')

if (process.env.KUN_VISUAL_NOVEL_TEST_SITE_LABEL) {
  console.log('DANGEROUS❗❗❗❗❗❗❗❗❗❗❗❗❗❗❗')
  console.log(
    'You website is running on a test environment now, it will be disable any search engine indexing!'
  )
}

process.exitCode = kunReportDeployChain(
  kunRunDeployChain({
    run: runCommand,
    capture: captureCommand,
    build: () => {
      rmSync(stagedDistDir, { recursive: true, force: true })
      runCommand('pnpm build', {
        ...process.env,
        NODE_ENV: 'production',
        KUN_DEPLOY_BUILD_SKIP_CHECKS: 'true',
        KUN_NEXT_DIST_DIR: stagedDistDir
      })
    },
    activate: activateStagedBuild
  })
)
