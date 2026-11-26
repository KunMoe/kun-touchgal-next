import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KUN_SEARCH_POST_ACTIVATE_STEPS,
  KUN_SEARCH_PRE_ACTIVATE_STEPS,
  kunCountPlannedMigrations,
  kunReportDeployChain,
  kunRunDeployChain
} from '../deployChain'

const STATUS = 'git status --porcelain'
const PULL = 'git pull --ff-only'
const INSTALL = 'pnpm install --frozen-lockfile'
const PRE_MIGRATE = 'pnpm db:migrate --phase pre'
const POST_PROBE = 'pnpm -s db:migrate --phase post --dry-run'
const FULL_VERIFY = 'pnpm db:verify --prisma'
const PRE_ONLY_VERIFY = 'pnpm db:verify --phase pre --expand'
const GENERATE = 'pnpm prisma:generate'
const POST_MIGRATE = 'pnpm db:migrate --phase post'
const SEARCH_PRE = 'pnpm search:ensure --apply --phase pre'
const SEARCH_POST = 'pnpm search:ensure --apply --phase post'
const SEARCH_RECONCILE = 'pnpm search:reconcile --enqueue-only --retry-failed'
const RELEASE_ID = '20261126030405-fc8b626'

// 构建之前的那次校验: 没有待执行的 post 时查全量, 有时只确认表与列都已建好
const chainWith = (verifyBeforeBuild: string, checkout = [PULL]) => [
  STATUS,
  ...checkout,
  'preflight',
  INSTALL,
  PRE_MIGRATE,
  POST_PROBE,
  verifyBeforeBuild,
  GENERATE,
  'build',
  'assemble',
  SEARCH_PRE,
  `canary ${RELEASE_ID}`,
  `activate ${RELEASE_ID}`,
  POST_MIGRATE,
  FULL_VERIFY,
  SEARCH_POST,
  SEARCH_RECONCILE
]
const NO_PENDING_POST_CHAIN = chainWith(FULL_VERIFY)
const PENDING_POST_CHAIN = chainWith(PRE_ONLY_VERIFY)
const upTo = (chain: string[], step: string) =>
  chain.slice(0, chain.indexOf(step) + 1)

// 记录每一步的执行顺序。failing 里的步骤执行时抛错; 「名字#n」只让第 n 次执行失败
const createChain = ({
  failing = [],
  pendingPost = 0,
  probeOutput = `共 ${pendingPost} 个 (--phase post)\n`,
  dirty = '',
  ref
}: {
  failing?: string[]
  pendingPost?: number
  probeOutput?: string
  dirty?: string
  ref?: string
} = {}) => {
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
      ref,
      run: step,
      capture: (command: string) => {
        step(command)
        return command === STATUS ? dirty : probeOutput
      },
      preflight: () => step('preflight'),
      build: () => step('build'),
      assemble: () => {
        step('assemble')
        return RELEASE_ID
      },
      canary: async (releaseId: string) => step(`canary ${releaseId}`),
      activate: async (releaseId: string) => step(`activate ${releaseId}`)
    }
  }
}

describe('kunRunDeployChain', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  const printed = () =>
    errorSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n')

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('没有待执行的 post 迁移时, 构建之前做全量校验', async () => {
    const { steps, deps } = createChain()

    await expect(kunRunDeployChain(deps)).resolves.toBe('ok')
    expect(steps).toEqual(NO_PENDING_POST_CHAIN)
  })

  // post 负责的删列、加约束要等新代码上线才执行, 构建之前全量比对会把带收缩的部署一律
  // 挡下来; 但新代码一启动就要用的表与列仍须在构建之前确认
  it('有待执行的 post 迁移时, 构建之前只确认表与列已建好, 全量比对留到 post 之后', async () => {
    const { steps, deps } = createChain({ pendingPost: 2 })

    await expect(kunRunDeployChain(deps)).resolves.toBe('ok')
    expect(steps).toEqual(PENDING_POST_CHAIN)
  })

  it('部署链里不再出现 prisma db push', async () => {
    const { steps, deps } = createChain({ pendingPost: 1 })
    await kunRunDeployChain(deps)
    const other = createChain()
    await kunRunDeployChain(other.deps)

    expect([...steps, ...other.steps].join('\n')).not.toMatch(/push/)
  })

  it('依赖按锁文件安装, 排在任何会用到依赖的步骤之前', async () => {
    const { steps, deps } = createChain()
    await kunRunDeployChain(deps)

    expect(steps.indexOf(INSTALL)).toBe(steps.indexOf('preflight') + 1)
    expect(steps.indexOf(INSTALL)).toBeLessThan(steps.indexOf(PRE_MIGRATE))
  })

  it('给了版本时切到它的分离 HEAD, 不在当前分支上 pull', async () => {
    const { steps, deps } = createChain({ ref: 'v1.2.3' })

    await expect(kunRunDeployChain(deps)).resolves.toBe('ok')
    expect(steps).toEqual(
      chainWith(FULL_VERIFY, [
        'git fetch origin',
        'git checkout --detach v1.2.3'
      ])
    )
  })

  it.each(['-f', 'main; rm -rf /', 'a b', '$(id)', ''])(
    '认不出的版本 %j 在执行任何命令之前被拒绝',
    async (ref) => {
      const { steps, deps } = createChain({ ref })

      await expect(kunRunDeployChain(deps)).rejects.toThrow(
        '认不出要部署的版本'
      )
      expect(steps).toEqual([])
    }
  )

  it('检出里有改动时在更新检出之前中止, 并列出改动', async () => {
    const { steps, deps } = createChain({
      dirty: ' M app/page.tsx\n?? x.txt\n'
    })

    await expect(kunRunDeployChain(deps)).rejects.toThrow('未提交的改动')
    expect(steps).toEqual([STATUS])
    expect(printed()).toContain('M app/page.tsx')
    expect(printed()).toContain('线上不变')
  })

  it('更新检出失败时提示分离 HEAD 的处理办法', async () => {
    const { steps, deps } = createChain({ failing: [PULL] })

    await expect(kunRunDeployChain(deps)).rejects.toThrow(PULL)
    expect(steps).toEqual([STATUS, PULL])
    expect(printed()).toContain('git switch main')
  })

  it('核对不通过时在装依赖之前中止, 原因原样打印', async () => {
    const { steps, deps } = createChain()
    deps.preflight = () => {
      steps.push('preflight')
      throw new Error('当前 shell 的 Node 是 v26.3.1')
    }

    await expect(kunRunDeployChain(deps)).rejects.toThrow('v26.3.1')
    expect(steps).toEqual([STATUS, PULL, 'preflight'])
    expect(printed()).toContain('当前 shell 的 Node 是 v26.3.1')
  })

  it('装依赖失败时在迁移之前中止', async () => {
    const { steps, deps } = createChain({ failing: [INSTALL] })

    await expect(kunRunDeployChain(deps)).rejects.toThrow(INSTALL)
    expect(steps).toEqual(upTo(NO_PENDING_POST_CHAIN, INSTALL))
    expect(printed()).toContain('部署在构建之前中止, 线上不变')
  })

  it('判断不出有没有待执行的 post 迁移时在构建之前中止', async () => {
    const { steps, deps } = createChain({ probeOutput: '看不懂的输出' })

    await expect(kunRunDeployChain(deps)).rejects.toThrow('认不出')
    expect(steps).toEqual(upTo(NO_PENDING_POST_CHAIN, POST_PROBE))
  })

  it('pre 迁移失败时在构建之前中止并说明线上不受影响', async () => {
    const { steps, deps } = createChain({ failing: [PRE_MIGRATE] })

    await expect(kunRunDeployChain(deps)).rejects.toThrow(PRE_MIGRATE)
    expect(steps).toEqual(upTo(NO_PENDING_POST_CHAIN, PRE_MIGRATE))
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'pre 迁移失败: 部署在构建之前中止, 线上的构建没有变化'
      )
    )
  })

  it.each([
    [`${FULL_VERIFY}#1`, 0, NO_PENDING_POST_CHAIN, FULL_VERIFY],
    [PRE_ONLY_VERIFY, 1, PENDING_POST_CHAIN, PRE_ONLY_VERIFY]
  ])(
    '构建之前的校验 %s 失败时中止部署: 不生成 client、不构建、不切换',
    async (failingStep, pendingPost, chain, verifyStep) => {
      const { steps, deps } = createChain({
        failing: [failingStep],
        pendingPost
      })

      await expect(kunRunDeployChain(deps)).rejects.toThrow('db:verify')
      expect(steps).toEqual(upTo(chain, verifyStep))
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '构建之前的数据库校验未通过: 部署中止, 线上的构建没有变化'
        )
      )
    }
  )

  it.each([POST_PROBE, GENERATE, 'build', 'assemble'])(
    '%s 失败时中止, 不跑金丝雀、不切换、不执行 post 迁移',
    async (failingStep) => {
      const { steps, deps } = createChain({ failing: [failingStep] })

      await expect(kunRunDeployChain(deps)).rejects.toThrow(failingStep)
      expect(steps).toEqual(upTo(NO_PENDING_POST_CHAIN, failingStep))
    }
  )

  it('金丝雀没通过时不切换, 说明线上不变、已执行的只有兼容旧代码的两步', async () => {
    const { steps, deps } = createChain({ failing: [`canary ${RELEASE_ID}`] })

    await expect(kunRunDeployChain(deps)).rejects.toThrow('canary')
    expect(steps).toEqual(upTo(NO_PENDING_POST_CHAIN, `canary ${RELEASE_ID}`))
    expect(printed()).toContain(
      `金丝雀没有通过: 发布 ${RELEASE_ID} 没有上线, 线上不变`
    )
    expect(printed()).toContain('pre 迁移与搜索索引的扩张已执行')
  })

  it('切换没通过时中止并提示 post 迁移尚未执行', async () => {
    const { steps, deps } = createChain({
      failing: [`activate ${RELEASE_ID}`]
    })

    await expect(kunRunDeployChain(deps)).rejects.toThrow('activate')
    expect(steps).toEqual(upTo(NO_PENDING_POST_CHAIN, `activate ${RELEASE_ID}`))
    expect(printed()).toContain('post 迁移尚未执行')
    expect(printed()).toContain('pnpm deploy:list')
  })

  it('post 迁移失败时不抛错也不再校验: 新构建已上线, 交给调用方报告', async () => {
    const { steps, deps } = createChain({
      failing: [POST_MIGRATE],
      pendingPost: 1
    })

    await expect(kunRunDeployChain(deps)).resolves.toBe('post-migration-failed')
    // 搜索的收尾与数据库无关, 照常执行
    expect(steps).toEqual(
      PENDING_POST_CHAIN.filter((step) => step !== FULL_VERIFY)
    )
  })

  it.each([
    [`${FULL_VERIFY}#2`, 0],
    [FULL_VERIFY, 1]
  ])(
    '切换之后的校验 %s 失败时不抛错: 新构建已上线, 不能当成没部署',
    async (failingStep, pendingPost) => {
      const { steps, deps } = createChain({
        failing: [failingStep],
        pendingPost
      })

      await expect(kunRunDeployChain(deps)).resolves.toBe('verify-failed')
      expect(steps).toHaveLength(NO_PENDING_POST_CHAIN.length)
    }
  )

  it('搜索索引的扩张在金丝雀之前、收缩与对账在 post 迁移之后', () => {
    const commands = (steps: { command: string }[]) =>
      steps.map(({ command }) => command)
    expect(commands(KUN_SEARCH_PRE_ACTIVATE_STEPS)).toEqual([SEARCH_PRE])
    expect(commands(KUN_SEARCH_POST_ACTIVATE_STEPS)).toEqual([
      SEARCH_POST,
      SEARCH_RECONCILE
    ])
    const order = (step: string) => NO_PENDING_POST_CHAIN.indexOf(step)
    expect(order(SEARCH_PRE)).toBe(order(`canary ${RELEASE_ID}`) - 1)
    expect(order(SEARCH_POST)).toBeGreaterThan(order(FULL_VERIFY))
  })

  it.each([SEARCH_PRE, SEARCH_POST, SEARCH_RECONCILE])(
    '搜索步骤 %s 失败只告警: 后面的步骤照常执行, 结局不变',
    async (failingStep) => {
      const { steps, deps } = createChain({ failing: [failingStep] })

      await expect(kunRunDeployChain(deps)).resolves.toBe('ok')
      expect(steps).toEqual(NO_PENDING_POST_CHAIN)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `搜索索引的部署步骤失败, 部署照常继续: ${failingStep}`
        )
      )
      expect(warnSpy).toHaveBeenCalledTimes(1)
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
    // post 迁移改到的文档要再对账一次才会重写
    expect(printed()).toContain('pnpm search:reconcile --enqueue-only')
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
