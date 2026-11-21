import { mkdir, readdir, copyFile, stat } from 'fs/promises'
import path from 'path'

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

const assertExists = async (targetPath: string) => {
  await stat(targetPath)
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

    await assertExists(path.join(standaloneDir, 'public/logo.webp'))
    await assertExists(
      path.join(standaloneDir, 'public/sooner/こじかひわ.webp')
    )
    await assertExists(path.join(standaloneDir, 'public/cap/cap_wasm_bg.wasm'))
    await assertExists(path.join(standaloneDir, 'posts'))
    await assertExists(path.join(standaloneDir, 'config/redirect.json'))

    console.log('Files copied successfully.')
  } catch (error) {
    console.error('Error during postbuild:', error)
    process.exit(1)
  }
}

copyFiles()
