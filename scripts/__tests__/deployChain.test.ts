import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  kunCountPlannedMigrations,
  kunReportDeployChain,
  kunRunDeployChain
} from '../deployChain'

const PRE_MIGRATE = 'pnpm db:migrate --phase pre'
const POST_PROBE = 'pnpm -s db:migrate --phase post --dry-run'
const FULL_VERIFY = 'pnpm db:verify --prisma'
const PRE_ONLY_VERIFY = 'pnpm db:verify --phase pre --expand'
const GENERATE = 'pnpm prisma:generate'
const POST_MIGRATE = 'pnpm db:migrate --phase post'

// 构建之前的那次校验: 没有待执行的 post 时查全量, 有时只确认表与列都已建好
const chainWith = (verifyBeforeBuild: string) => [
  'git pull',
  PRE_MIGRATE,
  POST_PROBE,
  verifyBeforeBuild,
  GENERATE,
  'build',
  'activate',
  POST_MIGRATE,
  FULL_VERIFY
]
const NO_PENDING_POST_CHAIN = chainWith(FULL_VERIFY)
const PENDING_POST_CHAIN = chainWith(PRE_ONLY_VERIFY)

// 记录每一步的执行顺序。failing 里的步骤执行时抛错; 「名字#n」只让第 n 次执行失败
const createChain = ({
  failing = [],
  pendingPost = 0,
  probeOutput = `共 ${pendingPost} 个 (--phase post)\n`
}: { failing?: string[]; pendingPost?: number; probeOutput?: string } = {}) => {
  const steps: string[] = []
  const step = (name: string) => {
    steps.push(name)
    const nth = steps.filter((seen) => seen === name).length
    if (failing.includes(name) || failing.includes(`${name}#${nth}`)) {
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

  it('没有待执行的 post 迁移时, 构建之前做全量校验', () => {
    const { steps, deps } = createChain()

    expect(kunRunDeployChain(deps)).toBe('ok')
    expect(steps).toEqual(NO_PENDING_POST_CHAIN)
  })

  // post 负责的删列、加约束要等新代码上线才执行, 构建之前全量比对会把带收缩的部署一律
  // 挡下来; 但新代码一启动就要用的表与列仍须在构建之前确认
  it('有待执行的 post 迁移时, 构建之前只确认表与列已建好, 全量比对留到 post 之后', () => {
    const { steps, deps } = createChain({ pendingPost: 2 })

    expect(kunRunDeployChain(deps)).toBe('ok')
    expect(steps).toEqual(PENDING_POST_CHAIN)
  })

  it('部署链里不再出现 prisma db push', () => {
    const { steps, deps } = createChain({ pendingPost: 1 })
    kunRunDeployChain(deps)
    const other = createChain()
    kunRunDeployChain(other.deps)

    expect([...steps, ...other.steps].join('\n')).not.toMatch(/push/)
  })

  it('判断不出有没有待执行的 post 迁移时在构建之前中止', () => {
    const { steps, deps } = createChain({ probeOutput: '看不懂的输出' })

    expect(() => kunRunDeployChain(deps)).toThrow('认不出')
    expect(steps).toEqual(NO_PENDING_POST_CHAIN.slice(0, 3))
  })

  it('pre 迁移失败时在构建之前中止并说明线上不受影响', () => {
    const { steps, deps } = createChain({ failing: [PRE_MIGRATE] })

    expect(() => kunRunDeployChain(deps)).toThrow(PRE_MIGRATE)
    expect(steps).toEqual(['git pull', PRE_MIGRATE])
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'pre 迁移失败: 部署在构建之前中止, 线上的构建没有变化'
      )
    )
  })

  it.each([
    [`${FULL_VERIFY}#1`, 0, NO_PENDING_POST_CHAIN],
    [PRE_ONLY_VERIFY, 1, PENDING_POST_CHAIN]
  ])(
    '构建之前的校验 %s 失败时中止部署: 不生成 client、不构建、不切换',
    (failingStep, pendingPost, chain) => {
      const { steps, deps } = createChain({
        failing: [failingStep],
        pendingPost
      })

      expect(() => kunRunDeployChain(deps)).toThrow('db:verify')
      expect(steps).toEqual(chain.slice(0, 4))
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '构建之前的数据库校验未通过: 部署中止, 线上的构建没有变化'
        )
      )
    }
  )

  it.each(['git pull', POST_PROBE, GENERATE, 'build'])(
    '%s 失败时中止, 不切换也不执行 post 迁移',
    (failingStep) => {
      const { steps, deps } = createChain({ failing: [failingStep] })

      expect(() => kunRunDeployChain(deps)).toThrow(failingStep)
      expect(steps).toEqual(
        NO_PENDING_POST_CHAIN.slice(
          0,
          NO_PENDING_POST_CHAIN.indexOf(failingStep) + 1
        )
      )
    }
  )

  it('切换失败时中止并提示 post 迁移尚未执行', () => {
    const { steps, deps } = createChain({ failing: ['activate'] })

    expect(() => kunRunDeployChain(deps)).toThrow('activate')
    expect(steps).toEqual(NO_PENDING_POST_CHAIN.slice(0, 7))
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('post 迁移尚未执行')
    )
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'pnpm db:migrate --phase post && pnpm db:verify --prisma'
      )
    )
  })

  it('post 迁移失败时不抛错也不再校验: 新构建已上线, 交给调用方报告', () => {
    const { steps, deps } = createChain({
      failing: [POST_MIGRATE],
      pendingPost: 1
    })

    expect(kunRunDeployChain(deps)).toBe('post-migration-failed')
    expect(steps).toEqual(PENDING_POST_CHAIN.slice(0, 8))
  })

  it.each([
    [`${FULL_VERIFY}#2`, 0],
    [FULL_VERIFY, 1]
  ])(
    '切换之后的校验 %s 失败时不抛错: 新构建已上线, 不能当成没部署',
    (failingStep, pendingPost) => {
      const { steps, deps } = createChain({
        failing: [failingStep],
        pendingPost
      })

      expect(kunRunDeployChain(deps)).toBe('verify-failed')
      expect(steps).toHaveLength(9)
    }
  )
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

  it('个数可以不止一位', () => {
    expect(kunCountPlannedMigrations('共 12 个 (--phase post)\n')).toBe(12)
  })

  it('只认行首的汇总行, 不被别的行里的同样字样带偏', () => {
    expect(
      kunCountPlannedMigrations(
        '将执行 0008_a.sql (post, tx) -- 共 9 个字段\n共 1 个 (--phase post)\n'
      )
    ).toBe(1)
  })
})

describe('kunReportDeployChain', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  const printed = () =>
    errorSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n')

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('全部通过时退出码为 0, 不打印报错', () => {
    expect(kunReportDeployChain('ok')).toBe(0)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  // 2 而不是 1: 切换之前中止是抛错 (退出码 1, 线上的构建没变), 要能从退出码上分开
  it('post 迁移失败时退出码为 2, 说明新构建已上线并给出补跑命令', () => {
    expect(kunReportDeployChain('post-migration-failed')).toBe(2)
    expect(printed()).toContain('post 迁移失败: 新构建已上线并在运行, 没有回滚')
    expect(printed()).toContain(
      'pnpm db:migrate --phase post && pnpm db:verify --prisma'
    )
    expect(printed()).not.toContain('收尾的数据库校验')
  })

  it('收尾校验失败时退出码为 2, 不叫人补跑 post 迁移', () => {
    expect(kunReportDeployChain('verify-failed')).toBe(2)
    expect(printed()).toContain(
      '收尾的数据库校验没有通过或没能跑完: 新构建已上线并在运行, post 迁移也已执行'
    )
    expect(printed()).toContain('pnpm db:verify --prisma')
    expect(printed()).not.toContain('pnpm db:migrate')
  })
})
