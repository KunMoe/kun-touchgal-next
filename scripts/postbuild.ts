import { mkdir, readdir, copyFile } from 'fs/promises'
import path from 'path'
import {
  formatVerifyReport,
  isVerifyClean,
  verifyRelease
} from './release/verify'

const distDir = process.env.KUN_NEXT_DIST_DIR ?? '.next'
const standaloneDir = path.join(distDir, 'standalone')

const copyDirectory = async (src: string, dest: string): Promise<void> => {
  try {
    await mkdir(dest, { recursive: true })
    const entries = await readdir(src, { withFileTypes: true })

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)

      if (entry.isDirectory()) {
        await copyDirectory(srcPath, destPath)
      } else {
        await copyFile(srcPath, destPath)
      }
    }
  } catch (error) {
    console.error(`Error copying directory from ${src} to ${dest}:`, error)
    throw error
  }
}

const copyRuntimeFile = async (src: string, dest: string): Promise<void> => {
  try {
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(src, dest)
  } catch (error) {
    console.error(`Error copying file from ${src} to ${dest}:`, error)
    throw error
  }
}

const waitForAllCopies = async (copyTasks: Promise<void>[]) => {
  const results = await Promise.allSettled(copyTasks)
  const rejectedResult = results.find((result) => result.status === 'rejected')

  if (rejectedResult?.status === 'rejected') {
    throw rejectedResult.reason
  }
}

const copyFiles = async () => {
  try {
    await waitForAllCopies([
      copyDirectory('public', path.join(standaloneDir, 'public')),
      copyDirectory(
        path.join(distDir, 'static'),
        path.join(standaloneDir, distDir, 'static')
      ),
      copyDirectory('posts', path.join(standaloneDir, 'posts')),
      copyRuntimeFile(
        'config/redirect.json',
        path.join(standaloneDir, 'config/redirect.json')
      )
    ])

    console.log('Files copied successfully.')

    // 发布在检出之外运行, standalone 缺的文件与外部包上线后直接崩: 这里就挡下 (见 release/verify.ts)
    const report = verifyRelease(standaloneDir, { distDir })
    if (!isVerifyClean(report)) {
      console.error(formatVerifyReport(report))
      process.exit(1)
    }
    console.log(
      `standalone 自检通过: 探测了 ${report.externals.length} 个外部包说明符`
    )
  } catch (error) {
    console.error('Error during postbuild:', error)
    process.exit(1)
  }
}

copyFiles()
