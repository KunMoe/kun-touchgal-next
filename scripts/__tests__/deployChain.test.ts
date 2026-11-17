import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  kunCountPlannedMigrations,
  kunReportDeployChain,
  kunRunDeployChain
} from '../deployChain'

const PRE_MIGRATE = 'pnpm db:migrate --phase pre'
const POST_PROBE = 'pnpm -s db:migrate --phase post --dry-run'
const PUSH = 'pnpm prisma:push'
const POST_MIGRATE = 'pnpm db:migrate --phase post'

// 没有待执行的 post 迁移: push 排在构建之前
const PUSH_FIRST_CHAIN = [
  'git pull',
  PRE_MIGRATE,
  POST_PROBE,
  'pnpm db:verify --phase pre --prisma',
  PUSH,
  'build',
  'activate',
  POST_MIGRATE,
  'pnpm db:verify'
]

// 有待执行的 post 迁移: push 推迟到 post 之后
const PUSH_LAST_CHAIN = [
  'git pull',
  PRE_MIGRATE,
  POST_PROBE,
  'pnpm db:verify --phase pre',
  'build',
  'activate',
  POST_MIGRATE,
  'pnpm db:verify --prisma',
  PUSH
]

// 记录每一步的执行顺序; failing 里的步骤执行时抛错
const createChain = ({
  failing = [],
  pendingPost = 0,
  probeOutput = `共 ${pendingPost} 个 (--phase post)\n`
}: { failing?: string[]; pendingPost?: number; probeOutput?: string } = {}) => {
  const steps: string[] = []
  const step = (name: string) => {
    steps.push(name)
    if (failing.includes(name)) {
      throw new Error(`Command failed: ${name}`)
    }
  }
  return {
    steps,
    deps: {
      run: step,
      capture: (command: string) => {
        step(command)
        return probeOutput
      },
      build: () => step('build'),
      activate: () => step('activate')
    }
  }
}

describe('kunRunDeployChain', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('没有待执行的 post 迁移时, push 在 pre 迁移与校验之后、构建之前', () => {
    const { steps, deps } = createChain()

    expect(kunRunDeployChain(deps)).toEqual({
      warnings: [],
      postMigrationFailed: false
    })
    expect(steps).toEqual(PUSH_FIRST_CHAIN)
  })

  // push 会把表结构直接推到 schema: 排在 post 之前就是在旧构建还在线时抢先做掉
  // post 里的删列、加约束, 或者因为数据丢失告警而让部署停在 push
  it('有待执行的 post 迁移时, push 推迟到 post 迁移与校验之后', () => {
    const { steps, deps } = createChain({ pendingPost: 2 })

    expect(kunRunDeployChain(deps)).toEqual({
      warnings: [],
      postMigrationFailed: false
    })
    expect(steps).toEqual(PUSH_LAST_CHAIN)
  })

  it('判断不出有没有待执行的 post 迁移时在构建之前中止', () => {
    const { steps, deps } = createChain({ probeOutput: '看不懂的输出' })

    expect(() => kunRunDeployChain(deps)).toThrow('认不出')
    expect(steps).toEqual(PUSH_FIRST_CHAIN.slice(0, 3))
  })

  it('pre 迁移失败时在构建之前中止并说明线上不受影响', () => {
    const { steps, deps } = createChain({ failing: [PRE_MIGRATE] })

    expect(() => kunRunDeployChain(deps)).toThrow(PRE_MIGRATE)
    expect(steps).toEqual(['git pull', PRE_MIGRATE])
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('线上仍在运行上一个版本')
    )
  })

  it.each(['git pull', POST_PROBE, PUSH, 'build'])(
    '%s 失败时中止, 不切换也不执行 post 迁移',
    (failingStep) => {
      const { steps, deps } = createChain({ failing: [failingStep] })

      expect(() => kunRunDeployChain(deps)).toThrow(failingStep)
      expect(steps).toEqual(
        PUSH_FIRST_CHAIN.slice(0, PUSH_FIRST_CHAIN.indexOf(failingStep) + 1)
      )
    }
  )

  it('切换失败时中止并提示 post 迁移尚未执行', () => {
    const { steps, deps } = createChain({ failing: ['activate'] })

    expect(() => kunRunDeployChain(deps)).toThrow('activate')
    expect(steps).toEqual(PUSH_FIRST_CHAIN.slice(0, 7))
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('post 迁移尚未执行')
    )
  })

  it.each([
    ['pnpm db:verify --phase pre --prisma', 0, 'push 之前的校验'],
    ['pnpm db:verify', 0, '收尾校验'],
    ['pnpm db:verify --phase pre', 1, '构建之前的校验'],
    ['pnpm db:verify --prisma', 1, 'push 之前的校验']
  ])('%s 失败只记告警, 部署照常走完', (command, pendingPost, stage) => {
    const { steps, deps } = createChain({ failing: [command], pendingPost })

    expect(kunRunDeployChain(deps)).toEqual({
      warnings: [`${stage}未通过: ${command}`],
      postMigrationFailed: false
    })
    expect(steps).toEqual(pendingPost ? PUSH_LAST_CHAIN : PUSH_FIRST_CHAIN)
  })

  it('post 迁移失败时不抛错, 不再校验也不 push, 之前的告警保留', () => {
    const { steps, deps } = createChain({
      failing: ['pnpm db:verify --phase pre', POST_MIGRATE],
      pendingPost: 1
    })

    expect(kunRunDeployChain(deps)).toEqual({
      warnings: ['构建之前的校验未通过: pnpm db:verify --phase pre'],
      postMigrationFailed: true
    })
    expect(steps).toEqual(PUSH_LAST_CHAIN.slice(0, 7))
  })

  it('推迟的 push 失败只记告警: 新构建已上线, 不能当成部署失败', () => {
    const { deps } = createChain({ failing: [PUSH], pendingPost: 1 })

    const result = kunRunDeployChain(deps)

    expect(result.postMigrationFailed).toBe(false)
    expect(result.warnings).toEqual([
      expect.stringContaining('安全网 pnpm prisma:push 失败')
    ])
  })
})

describe('kunCountPlannedMigrations', () => {
  it('取 db:migrate --dry-run 汇总行里的个数', () => {
    expect(kunCountPlannedMigrations('共 0 个 (--phase post)\n')).toBe(0)
    expect(
      kunCountPlannedMigrations(
        '将执行 0008_a.sql (post, tx)\n将执行 0009_b.notx.sql (post, notx)\n共 2 个 (--phase post)\n'
      )
    ).toBe(2)
  })

  it('没有汇总行时报错, 不当成 0 个', () => {
    expect(() => kunCountPlannedMigrations('')).toThrow('认不出')
  })
})

describe('kunReportDeployChain', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('全部通过时退出码为 0, 不打印告警', () => {
    expect(
      kunReportDeployChain({ warnings: [], postMigrationFailed: false })
    ).toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('只有告警时逐条打印, 退出码仍为 0', () => {
    expect(
      kunReportDeployChain({
        warnings: ['收尾校验未通过: pnpm db:verify'],
        postMigrationFailed: false
      })
    ).toBe(0)
    expect(warnSpy).toHaveBeenCalledWith('  收尾校验未通过: pnpm db:verify')
  })

  it('post 迁移失败时退出码为 1, 并给出补跑命令', () => {
    expect(
      kunReportDeployChain({ warnings: [], postMigrationFailed: true })
    ).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('pnpm db:migrate --phase post')
    )
  })
})
