/* eslint-disable no-console */
import { prisma } from '~/prisma/index'
import {
  MARKDOWN_MAX_DIRECTIVE_FENCE_LINES,
  MARKDOWN_MAX_LINE_CONTAINER_MARKERS,
  MARKDOWN_MAX_PARAGRAPH_BRACKETS,
  MARKDOWN_MAX_TREE_DEPTH,
  measureMarkdownCost,
  measureTreeDepth
} from '~/app/api/utils/render/markdownBudget'
import { renderKunMarkdown } from '~/app/api/utils/render/renderKunMarkdown'
import { getKunMarkdownProcessor } from '~/app/api/utils/render/processor'
import { KUN_MARKDOWN_PROFILES } from '~/app/api/utils/render/profiles'
import type { KunMarkdownProfile } from '~/app/api/utils/render/renderKunMarkdown'

// 只读盘点: 现有内容在渲染预算 (markdownBudget.ts) 下的分布, 用来校准各个阈值。
// 不写库、不碰 Redis。改预算前后、发布前各跑一次:
//   pnpm exec esno scripts/inventoryMarkdownBudget.ts
//
// 看三处: (1) 各来源「最大值」离阈值多远; (2) 「非 ok」的行是否都是该降级的病理输入;
// (3) 评论里「已按当前版本落库却会被新预算降级」的行 —— 有的话应抬高阈值盖住它们,
// 不要靠递增版本把它们降级

const COMMENT_HTML_VERSION = KUN_MARKDOWN_PROFILES.comment.version
const BATCH_SIZE = 500
const SAMPLE_LIMIT = 20

const PARSERS: Record<
  KunMarkdownProfile,
  (markdown: string) => { children?: unknown[] }
> = {
  comment: (markdown) => getKunMarkdownProcessor('comment').parse(markdown),
  note: (markdown) => getKunMarkdownProcessor('note').parse(markdown),
  introduction: (markdown) =>
    getKunMarkdownProcessor('introduction').parse(markdown)
}

interface SourceStats {
  rows: number
  maxBytes: number
  maxMarkers: number
  maxDirectiveFences: number
  maxBrackets: number
  // 放行的行的 mdast 深度 → 行数
  depths: Map<number, number>
  reasons: Map<string, number>
  samples: string[]
  slowestMs: number
  slowestId: string
}

const createStats = (): SourceStats => ({
  rows: 0,
  maxBytes: 0,
  maxMarkers: 0,
  maxDirectiveFences: 0,
  maxBrackets: 0,
  depths: new Map(),
  reasons: new Map(),
  samples: [],
  slowestMs: 0,
  slowestId: ''
})

const bump = <K>(map: Map<K, number>, key: K) =>
  map.set(key, (map.get(key) ?? 0) + 1)

// 返回该行在新预算下的结论: 'ok' 或失败原因
const inspect = async (
  stats: SourceStats,
  profile: KunMarkdownProfile,
  id: string,
  markdown: string
) => {
  stats.rows++
  stats.maxBytes = Math.max(stats.maxBytes, Buffer.byteLength(markdown, 'utf8'))

  const cost = measureMarkdownCost(markdown)
  stats.maxMarkers = Math.max(stats.maxMarkers, cost.maxLineContainerMarkers)
  stats.maxDirectiveFences = Math.max(
    stats.maxDirectiveFences,
    cost.directiveFenceLines
  )

  stats.maxBrackets = Math.max(stats.maxBrackets, cost.maxParagraphBrackets)

  const startedAt = performance.now()
  const result = await renderKunMarkdown(profile, markdown, { cache: false })
  const elapsed = performance.now() - startedAt
  if (elapsed > stats.slowestMs) {
    stats.slowestMs = elapsed
    stats.slowestId = id
  }

  const outcome = result.ok ? 'ok' : result.reason
  bump(stats.reasons, outcome)
  if (!result.ok && stats.samples.length < SAMPLE_LIMIT) {
    stats.samples.push(`${id}(${result.reason})`)
  }
  // 只给放行的行记真实深度: 被拒的行要么超了结构上限, 要么被熔断挡下 (不值得再解析)
  if (result.ok) {
    bump(stats.depths, measureTreeDepth(PARSERS[profile](markdown)))
  }
  return outcome
}

const percentile = (depths: Map<number, number>, fraction: number) => {
  const sorted = [...depths.entries()].sort((a, b) => a[0] - b[0])
  const total = sorted.reduce((sum, [, count]) => sum + count, 0)
  let seen = 0
  for (const [depth, count] of sorted) {
    seen += count
    if (seen >= total * fraction) {
      return depth
    }
  }
  return 0
}

const report = (name: string, stats: SourceStats) => {
  const maxDepth = Math.max(0, ...stats.depths.keys())
  console.log(`\n== ${name}: ${stats.rows} 行`)
  console.log(
    `  mdast 深度  p50=${percentile(stats.depths, 0.5)} p99=${percentile(stats.depths, 0.99)} p99.9=${percentile(stats.depths, 0.999)} 最大=${maxDepth}  (上限 ${MARKDOWN_MAX_TREE_DEPTH})`
  )
  console.log(
    `  单行容器标记 最大=${stats.maxMarkers}  (熔断 ${MARKDOWN_MAX_LINE_CONTAINER_MARKERS})`
  )
  console.log(
    `  容器指令开启行 最大=${stats.maxDirectiveFences}  (熔断 ${MARKDOWN_MAX_DIRECTIVE_FENCE_LINES})`
  )
  console.log(
    `  同段方括号 最大=${stats.maxBrackets}  (熔断 ${MARKDOWN_MAX_PARAGRAPH_BRACKETS})`
  )
  console.log(`  最大字节数=${stats.maxBytes}`)
  console.log(
    `  结论 ${[...stats.reasons.entries()].map(([reason, count]) => `${reason}=${count}`).join(' ')}`
  )
  console.log(
    `  最慢一行 ${stats.slowestMs.toFixed(0)}ms (${stats.slowestId || '-'})`
  )
  if (stats.samples.length > 0) {
    console.log(
      `  非 ok 样本 (至多 ${SAMPLE_LIMIT}): ${stats.samples.join(' ')}`
    )
  }
}

const inventoryComments = async () => {
  const stats = createStats()
  const versions = new Map<number, number>()
  // 版本落后或 HTML 为空: 读路径会重渲染的行
  const staleIds: number[] = []
  // 已按当前版本落库、新预算下却会被降级的行
  const regressedIds: number[] = []

  for (let cursorId = 0; ;) {
    const batch = await prisma.patch_comment.findMany({
      where: { id: { gt: cursorId } },
      select: {
        id: true,
        content: true,
        content_html: true,
        content_html_version: true
      },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' }
    })
    if (batch.length === 0) {
      break
    }
    for (const row of batch) {
      bump(versions, row.content_html_version)
      const stored =
        row.content_html_version === COMMENT_HTML_VERSION && row.content_html
      if (!stored) {
        staleIds.push(row.id)
      }
      const outcome = await inspect(
        stats,
        'comment',
        String(row.id),
        row.content
      )
      if (stored && outcome !== 'ok') {
        regressedIds.push(row.id)
      }
    }
    cursorId = batch[batch.length - 1].id
  }

  report('patch_comment.content (comment)', stats)
  console.log(
    `  content_html_version 分布 (当前 ${COMMENT_HTML_VERSION}): ${[
      ...versions.entries()
    ]
      .sort((a, b) => a[0] - b[0])
      .map(([version, count]) => `v${version}=${count}`)
      .join(' ')}`
  )
  console.log(
    `  版本落后或 HTML 为空 (读时重渲染): ${staleIds.length} 行 ${staleIds.slice(0, 50).join(',')}`
  )
  console.log(
    `  已按当前版本落库却会被新预算降级: ${regressedIds.length} 行 ${regressedIds.slice(0, 50).join(',')}`
  )
}

const inventoryNotes = async () => {
  const stats = createStats()
  for (let cursorId = 0; ;) {
    const batch = await prisma.patch_resource.findMany({
      where: { id: { gt: cursorId } },
      select: { id: true, note: true },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' }
    })
    if (batch.length === 0) {
      break
    }
    for (const row of batch) {
      if (row.note) {
        await inspect(stats, 'note', String(row.id), row.note)
      }
    }
    cursorId = batch[batch.length - 1].id
  }
  report('patch_resource.note (note)', stats)
}

const inventoryIntroductions = async () => {
  const stats = createStats()
  for (let cursorId = 0; ;) {
    const batch = await prisma.patch.findMany({
      where: { id: { gt: cursorId } },
      select: { id: true, introduction: true },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' }
    })
    if (batch.length === 0) {
      break
    }
    for (const row of batch) {
      await inspect(stats, 'introduction', String(row.id), row.introduction)
    }
    cursorId = batch[batch.length - 1].id
  }
  report('patch.introduction (introduction)', stats)
}

// 待处理申诉里用户提交的正文: 通过申诉时会写回评论 / 资源备注
const inventoryPendingAppeals = async () => {
  const stats = createStats()
  const appeals = await prisma.moderation_appeal.findMany({
    where: { status: 'pending', content_type: { in: ['comment', 'resource'] } },
    select: { id: true, content_type: true, payload: true }
  })
  for (const appeal of appeals) {
    const payload = (appeal.payload ?? {}) as { text?: unknown; note?: unknown }
    const [profile, markdown] =
      appeal.content_type === 'comment'
        ? (['comment', payload.text] as const)
        : (['note', payload.note] as const)
    if (typeof markdown === 'string' && markdown) {
      await inspect(
        stats,
        profile,
        `${appeal.content_type}-appeal-${appeal.id}`,
        markdown
      )
    }
  }
  report('moderation_appeal.payload (pending)', stats)
}

const inventoryMarkdownBudget = async () => {
  await inventoryComments()
  await inventoryNotes()
  await inventoryIntroductions()
  await inventoryPendingAppeals()
}

inventoryMarkdownBudget()
  .catch((error) => {
    console.error('[inventory] fatal:', error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
