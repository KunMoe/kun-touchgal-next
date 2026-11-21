import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn() }))

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: existsSyncMock
}))

// 脚本一导入就执行检查, 每个用例重新导入一次
const runPrebuild = () => import('~/scripts/prebuild')

describe('scripts/prebuild', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.resetModules()
  })

  it('public 下没有同名文件时放行', async () => {
    existsSyncMock.mockReturnValue(false)

    await expect(runPrebuild()).resolves.toBeDefined()
  })

  it('public/robots.txt 存在时不开始构建', async () => {
    existsSyncMock.mockImplementation(
      (file: string) => file === 'public/robots.txt'
    )

    await expect(runPrebuild()).rejects.toThrow('public/robots.txt')
  })

  // 少了这个钩子, 上面的检查就不会在 pnpm build 之前执行
  it('挂在 pnpm build 之前', () => {
    const { scripts } = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../package.json', import.meta.url)),
        'utf-8'
      )
    )

    expect(scripts.prebuild).toBe('esno scripts/prebuild.ts')
  })
})
