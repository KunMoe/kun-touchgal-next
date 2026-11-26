import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { kunReleaseLayout } from '../layout.cjs'

const require = createRequire(import.meta.url)
const ecosystemPath = require.resolve('../../../ecosystem.config.cjs')
const repoDir = path.dirname(ecosystemPath)
const { currentLink } = kunReleaseLayout(repoDir)

interface App {
  name: string
  cwd: string
  script: string
}

// ecosystem 在 require 时看一次 current 在不在: 每次都重新加载
const loadApps = () => {
  delete require.cache[ecosystemPath]
  return (require(ecosystemPath) as { apps: App[] }).apps
}

// 发布根在检出之外, 测试不去那里建目录: 只替换 ecosystem 对 current 的那一次 lstat
const stubCurrent = (state: 'present' | 'absent') => {
  const real = fs.lstatSync
  vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike) => {
    if (String(target) !== currentLink) {
      return real(target)
    }
    if (state === 'absent') {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return { isSymbolicLink: () => true } as fs.Stats
  }) as typeof fs.lstatSync)
}

afterEach(() => {
  vi.restoreAllMocks()
  delete require.cache[ecosystemPath]
})

describe('ecosystem.config.cjs', () => {
  it('runs both apps from the current release when the link exists (dangling included: start fails loudly)', () => {
    stubCurrent('present')
    for (const app of loadApps()) {
      expect(app.cwd, app.name).toBe(currentLink)
      expect(app.script, app.name).toBe('./server.js')
    }
  })

  it('falls back to the legacy build in the checkout without current', () => {
    stubCurrent('absent')
    for (const app of loadApps()) {
      expect(app.cwd, app.name).toBe(repoDir)
      expect(app.script, app.name).toBe('./.next/standalone/server.js')
    }
  })

  it('looks for current next to the checkout, never inside it', () => {
    expect(path.relative(repoDir, currentLink).startsWith('..')).toBe(true)
  })
})
