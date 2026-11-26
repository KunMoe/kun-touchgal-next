// 把线上切到一个发布: 停掉全部应用 → 换 current → 启动 → 闸门 (每个 app 的进程都 online 且跑在声明的
// Node 上, 每个端口的 /api/health 回的是这个发布), 闸门不过就切回原来的发布 (首次切换时删掉 current,
// ecosystem.config.cjs 回退到检出里的旧构建)。
//
// current 只在全部应用都删掉之后才换 (原因见 layout.ts 文件头)。部署链在切换成功之后才执行 post 迁移
// (scripts/deployChain.ts), 所以这里的自动回滚不会落到库结构不兼容的旧代码上。闸门与 PM2 的失败一律
// 作为返回值交出去, 不抛: 部署链要据此决定退出码, 并且照样打印发生了什么
import {
  listReleases,
  planPrune,
  readCurrentReleaseId,
  removeRelease,
  switchCurrentRelease
} from './layout'
import type { ReleaseId, ReleaseLayout } from './layout'
import type { KunAppSpec, KunPm2, KunPm2Process } from './pm2'

export interface KunHealth {
  status: number
  release: string | null
}

export interface ActivateDeps {
  layout: ReleaseLayout
  pm2: KunPm2
  apps: readonly KunAppSpec[]
  // 期望的 process.versions.node (不带 v), 取自 .node-version
  expectedNode: string
  // 没有应答 (连不上、超时) 时是 null
  fetchHealth(port: number): Promise<KunHealth | null>
  sleep(ms: number): Promise<void>
  log(message: string): void
  now?: () => number
  // 一次闸门 (含 pm2 update) 的总时限
  gateTimeoutMs?: number
  pollMs?: number
}

export type ActivationResult =
  | { ok: true; id: ReleaseId; previous: ReleaseId | null; pruned: ReleaseId[] }
  | {
      ok: false
      id: ReleaseId
      // null 是旧布局 (检出里的构建)
      rolledBackTo: ReleaseId | null
      reason: string
      // 回滚本身没做成, 或做完了但健康检查没过: 线上可能不在任何一个发布上, 要人看
      rollbackFailed?: string
    }

interface GateClock {
  deps: ActivateDeps
  now: () => number
  pollMs: number
  timeoutSeconds: number
  deadline: number
}

const startClock = (deps: ActivateDeps): GateClock => {
  const now = deps.now ?? Date.now
  const timeoutMs = deps.gateTimeoutMs ?? 120_000
  return {
    deps,
    now,
    pollMs: deps.pollMs ?? 1000,
    timeoutSeconds: Math.round(timeoutMs / 1000),
    deadline: now() + timeoutMs
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const labelOf = (id: ReleaseId | null) => id ?? '检出里的旧构建 (旧布局)'

// 每个 app 都有 instances 个 online 的进程才算起来了。errored 是 PM2 放弃重启之后的终态, 不必等到超时
const waitOnline = async (
  clock: GateClock
): Promise<KunPm2Process[] | string> => {
  const { pm2, apps, sleep } = clock.deps
  for (;;) {
    const processes = pm2.list()
    const errored = [
      ...new Set(
        processes
          .filter((proc) => proc.status === 'errored')
          .map((proc) => proc.name)
      )
    ]
    if (errored.length > 0) {
      return `${errored.join(', ')} 的进程是 errored (PM2 已放弃重启)`
    }
    const pending = apps.flatMap((app) => {
      const online = processes.filter(
        (proc) => proc.name === app.name && proc.status === 'online'
      ).length
      return online < app.instances
        ? [`${app.name} ${online}/${app.instances}`]
        : []
    })
    if (pending.length === 0) {
      return processes
    }
    if (clock.now() >= clock.deadline) {
      return `${clock.timeoutSeconds} 秒内进程没有全部 online: ${pending.join(', ')}`
    }
    await sleep(clock.pollMs)
  }
}

const describeNodes = (processes: readonly KunPm2Process[]) =>
  [
    ...new Set(
      processes.map(
        (proc) => `${proc.name} 在 ${proc.nodeVersion ?? '未知版本'}`
      )
    )
  ].join(', ')

const describeHealth = (health: KunHealth | null) =>
  health === null
    ? '没有应答'
    : `${health.status}, release=${health.release ?? 'null'}`

// release 为 null 时 (回到旧布局) 有 HTTP 应答就算起来了: 旧构建的 .env 里没有发布 id, 更早的构建
// 连 /api/health 都没有 (回 404)。只认 200 的话, 旧布局明明在服务也会被报成回滚失败
const waitHealthy = async (
  clock: GateClock,
  release: ReleaseId | null
): Promise<string | null> => {
  const { apps, fetchHealth, sleep } = clock.deps
  for (const app of apps) {
    for (;;) {
      const health = await fetchHealth(app.port)
      if (
        release === null
          ? health !== null
          : health?.status === 200 && health.release === release
      ) {
        break
      }
      if (clock.now() >= clock.deadline) {
        return `${app.name} (端口 ${app.port}) 的 /api/health ${clock.timeoutSeconds} 秒内${release === null ? '没有应答' : `没有回 200 与 release=${release}`}, 最后一次是 ${describeHealth(health)}`
      }
      await sleep(clock.pollMs)
    }
  }
  return null
}

// 通过时返回 null, 否则返回原因
const runGate = async (
  deps: ActivateDeps,
  id: ReleaseId
): Promise<string | null> => {
  const { pm2, expectedNode, log } = deps
  const clock = startClock(deps)
  log(`启动应用 (${id})`)
  pm2.startAll()
  let processes = await waitOnline(clock)
  if (typeof processes === 'string') {
    return processes
  }
  let mismatched = processes.filter((proc) => proc.nodeVersion !== expectedNode)
  if (mismatched.length > 0) {
    // PM2 守护进程常驻, 拉起的应用跑在它启动时的 node 上; pm2 update 换成当前 shell 的 node
    log(
      `进程的 Node 与 .node-version 的 ${expectedNode} 不一致 (${describeNodes(mismatched)}), 执行 pm2 update`
    )
    pm2.update()
    processes = await waitOnline(clock)
    if (typeof processes === 'string') {
      return `pm2 update 之后${processes}`
    }
    mismatched = processes.filter((proc) => proc.nodeVersion !== expectedNode)
    if (mismatched.length > 0) {
      return `pm2 update 之后进程的 Node 仍与 ${expectedNode} 不一致: ${describeNodes(mismatched)}`
    }
  }
  return waitHealthy(clock, id)
}

const describeCurrent = (layout: ReleaseLayout) => {
  try {
    return labelOf(readCurrentReleaseId(layout))
  } catch (error) {
    return errorMessage(error)
  }
}

// 回到 target 并启动 (target 为 null 是删掉 current 回到旧布局)。尽力而为: 没做成的写进返回值, 不抛。
// 健康检查用一份新的时限, 失败只报告: 进程已经起来, 再回滚也没有更早的地方可去
const restore = async (
  deps: ActivateDeps,
  target: ReleaseId | null
): Promise<string | undefined> => {
  const { layout, pm2, log } = deps
  let unhealthy: string | null
  try {
    pm2.stopAll()
    switchCurrentRelease(layout, target)
    log(`current → ${labelOf(target)}, 启动应用`)
    pm2.startAll()
    unhealthy = await waitHealthy(startClock(deps), target)
    // pm2 update 之后 dump 里可能没有我们的应用, 起来之后都要存一次
    pm2.save()
  } catch (error) {
    return `回滚到 ${labelOf(target)} 没有做完: ${errorMessage(error)}。current 现在是 ${describeCurrent(layout)}, 用 pm2 ls 确认进程`
  }
  if (unhealthy !== null) {
    return `已回滚到 ${labelOf(target)} 并启动, 但健康检查没有通过: ${unhealthy}`
  }
  log(`已回滚到 ${labelOf(target)}`)
  return undefined
}

// 停 → 切 → 闸门, 不过就回到 fallback。成功之后的 save 与清理由调用方做
const switchWithGate = async (
  deps: ActivateDeps,
  id: ReleaseId,
  fallback: ReleaseId | null
): Promise<ActivationResult | null> => {
  const { layout, pm2, log } = deps
  let reason: string | null
  try {
    log('停止应用')
    pm2.stopAll()
    switchCurrentRelease(layout, id)
    log(`current → ${id}`)
    reason = await runGate(deps, id)
  } catch (error) {
    reason = errorMessage(error)
  }
  if (reason === null) {
    return null
  }
  log(`✗ ${id} 没有通过闸门: ${reason}`)
  log(`回滚到 ${labelOf(fallback)}`)
  const rollbackFailed = await restore(deps, fallback)
  return rollbackFailed === undefined
    ? { ok: false, id, rolledBackTo: fallback, reason }
    : { ok: false, id, rolledBackTo: fallback, reason, rollbackFailed }
}

// 闸门已过, 线上已在新发布上: save 失败不改变结局, 只提醒
const saveAfterSuccess = (deps: ActivateDeps) => {
  try {
    deps.pm2.save()
  } catch (error) {
    deps.log(
      `⚠ pm2 save 失败, 主机重启后 PM2 可能拉不起应用: ${errorMessage(error)}。手工执行 pm2 save`
    )
  }
}

// 清理失败不影响这次部署, 下次部署再删
const pruneReleases = (deps: ActivateDeps, id: ReleaseId): ReleaseId[] => {
  const { layout, log } = deps
  let planned: ReleaseId[]
  try {
    planned = planPrune(
      listReleases(layout).map((manifest) => manifest.id),
      id
    )
  } catch (error) {
    log(`⚠ 列不出旧发布, 这次不清理: ${errorMessage(error)}`)
    return []
  }
  const pruned: ReleaseId[] = []
  for (const old of planned) {
    try {
      removeRelease(layout, old)
      pruned.push(old)
      log(`删除旧发布 ${old}`)
    } catch (error) {
      log(`⚠ 删除旧发布 ${old} 失败: ${errorMessage(error)}`)
    }
  }
  return pruned
}

// current 认不出 (不是指向 releases/ 的软链) 时抛错, 这时还什么都没动
export const activateRelease = async (
  deps: ActivateDeps,
  id: ReleaseId
): Promise<ActivationResult> => {
  const previous = readCurrentReleaseId(deps.layout)
  const failed = await switchWithGate(deps, id, previous)
  if (failed) {
    return failed
  }
  saveAfterSuccess(deps)
  return { ok: true, id, previous, pruned: pruneReleases(deps, id) }
}

// 切回一个旧发布 (不给 target 时是在线发布之前最新的那一个), 闸门与部署相同, 不过就切回原来的; 不清理。
// 前提不满足 (旧布局在线、target 不存在) 时抛错, 这时还什么都没动
export const rollbackTo = async (
  deps: ActivateDeps,
  target?: ReleaseId
): Promise<ActivationResult> => {
  const { layout } = deps
  const current = readCurrentReleaseId(layout)
  if (current === null) {
    throw new Error(
      `${layout.currentLink} 不存在: 在线的是检出里的旧构建, 没有可以回滚的发布`
    )
  }
  const ids = listReleases(layout).map((manifest) => manifest.id)
  const to = target ?? ids.find((id) => id < current)
  if (to === undefined) {
    throw new Error(`没有比在线的 ${current} 更早的发布`)
  }
  if (!ids.includes(to)) {
    throw new Error(
      `${to} 不在 ${layout.releasesDir} 的发布里, 现有: ${ids.join(', ') || '无'}`
    )
  }
  if (to === current) {
    throw new Error(`${to} 就是在线的发布`)
  }
  const failed = await switchWithGate(deps, to, current)
  if (failed) {
    return failed
  }
  saveAfterSuccess(deps)
  return { ok: true, id: to, previous: current, pruned: [] }
}

// 闸门、回滚与部署链共用: 连不上、超时都是 null; 应答不是 JSON 或没有 release 时 release 为 null
export const kunFetchHealth = async (
  port: number
): Promise<KunHealth | null> => {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(3000)
    })
  } catch {
    return null
  }
  let release: string | null = null
  try {
    const body = (await response.json()) as { release?: unknown } | null
    release = typeof body?.release === 'string' ? body.release : null
  } catch {
    // 应答体不是 JSON, 或读到一半超时
  }
  return { status: response.status, release }
}
