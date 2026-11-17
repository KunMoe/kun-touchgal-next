/* eslint-disable no-console */
import { directiveFromMarkdown } from 'mdast-util-directive'
import { directive } from 'micromark-extension-directive'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { getKunMarkdownProcessor } from '~/app/api/utils/render/processor'
import { KUN_MARKDOWN_PROFILES } from '~/app/api/utils/render/profiles'
import { rehypeKunImageLoading } from '~/app/api/utils/render/rehypeKunImageLoading'
import { remarkKunExternalLinks } from '~/app/api/utils/render/remarkKunExternalLinks'
import { remarkKunLink } from '~/app/api/utils/render/remarkKunLink'
import { remarkKunVideo } from '~/app/api/utils/render/remarkKunVideo'
import { remarkKunWrapImage } from '~/app/api/utils/render/remarkKunWrapImage'
import { prisma } from '~/prisma/index'
import { KUN_DIRECTIVES } from '~/utils/markdown/kunDialect'
import type { Processor } from 'unified'
import type { Node } from 'unist'

// 指令方言 (T02 S3) 上线前的只读对照: 把库里的每条评论、每篇游戏简介分别用旧管线
// 与新管线渲染, 差异按成因归类。不写库、不碰 Redis。发布前在生产 (或只读副本) 上跑:
//   pnpm exec esno scripts/diffMarkdownDialect.ts
//
// 看三处:
// (1) 「其他」必须为 0 —— 那是下面几类成因解释不了的差异, 不为 0 不要发布;
// (2) 「行内短代码变原文」「指令写法变原文」列出的内容, 发布后会多出短代码或指令的
//     原文 (原先是卡片 / 播放器, 或什么都不显示)。这两类是按「文中有这种写法」
//     认定的, 要逐篇过目, 该改的由管理员改正或删掉那一行;
// (3) 「冒号恢复」的样本确实是被吞掉的文字回来了。
// 「空占位短代码」不用处理: 地址没填的短代码原先输出一个空标签, 现在不输出,
// 页面上前后都看不见。
// 发布并回填之后这份脚本即可删除
//
// 归类靠四条管线, 相邻两条只差一个变量, 所以前两段差异的成因是确定的:
//   旧   = 上线前的管线 (解析行内 / 整行 / 容器三种指令; 评论全删, 简介认不出的变空 div)
//   中   = 旧管线只去掉行内指令的解析            → 旧≠中: 冒号恢复 / 行内短代码
//   占位 = 「中」再去掉地址没填的整行短代码      → 中≠占位: 空占位短代码
//   新   = 现在的管线 (只认整行短代码, 认不出的按原文; 容器写法就是普通文字)
// 占位≠新 的差异只应来自「不合格的整行指令或容器写法」, 文中找不到就算「其他」

const BATCH_SIZE = 500
const SAMPLE_LIMIT = 20

type Profile = 'comment' | 'introduction'

interface DirectiveNode extends Node {
  name: string
  attributes?: Record<string, string | null | undefined> | null
  children: Node[]
}

const isDirective = (node: Node): node is DirectiveNode =>
  node.type === 'textDirective' ||
  node.type === 'leafDirective' ||
  node.type === 'containerDirective'

// 旧管线按名字认短代码, 不看写成哪种形态
const parseLegacyKun = (node: DirectiveNode) => {
  if (!Object.hasOwn(KUN_DIRECTIVES, node.name)) {
    return null
  }
  const name = node.name as keyof typeof KUN_DIRECTIVES
  const attrs = KUN_DIRECTIVES[name].parse(node.attributes ?? {})
  return attrs ? { name, attrs } : null
}

const buildLegacy = (
  profile: Profile,
  variant: { inlineDirectives: boolean; dropBlank?: boolean }
) => {
  const processor = unified()
  processor.use(remarkParse).use(remarkGfm).use(remarkFrontmatter)
  processor.use(function (this: Processor) {
    const data = this.data() as Record<string, unknown[] | undefined>
    ;(data.micromarkExtensions ??= []).push(
      variant.inlineDirectives ? directive() : { flow: directive().flow }
    )
    ;(data.fromMarkdownExtensions ??= []).push(directiveFromMarkdown())
  })
  if (variant.dropBlank) {
    processor.use(() => (tree: Node) => {
      const walk = (node: Node & { children?: Node[] }) => {
        if (!Array.isArray(node.children)) {
          return
        }
        node.children = node.children.filter(
          (child) => !(isDirective(child) && fateOf(child) === 'blank')
        )
        node.children.forEach(walk)
      }
      walk(tree)
    })
  }

  if (profile === 'comment') {
    processor.use(() => (tree: Node) => {
      const walk = (node: Node & { children?: Node[] }) => {
        if (!Array.isArray(node.children)) {
          return
        }
        node.children = node.children.filter((child) => !isDirective(child))
        node.children.forEach(walk)
      }
      walk(tree)
    })
  } else {
    // 合格的短代码交给现在的渲染插件画卡片 (它只认带标记的整行节点); 旧管线对
    // 三种形态一视同仁, 输出与节点类型无关
    processor.use(() => (tree: Node) => {
      visit(tree, (node) => {
        const kun = isDirective(node) ? parseLegacyKun(node) : null
        if (kun) {
          node.type = 'leafDirective'
          node.data = { ...node.data, kun }
        }
      })
    })
    processor.use(remarkKunVideo).use(remarkKunLink)
  }

  processor.use(remarkRehype).use(remarkKunExternalLinks)
  processor.use(rehypeSanitize, KUN_MARKDOWN_PROFILES[profile].schema)
  processor.use(rehypeKunImageLoading)
  if (profile === 'introduction') {
    processor.use(remarkKunWrapImage)
  }
  processor.use(rehypeStringify)
  return processor.freeze()
}

const pipelinesOf = (profile: Profile) => ({
  old: buildLegacy(profile, { inlineDirectives: true }),
  mid: buildLegacy(profile, { inlineDirectives: false }),
  blank: buildLegacy(profile, { inlineDirectives: false, dropBlank: true }),
  new: getKunMarkdownProcessor(profile)
})

const PIPELINES = {
  comment: pipelinesOf('comment'),
  introduction: pipelinesOf('introduction')
}

const render = (
  processor: { processSync: (markdown: string) => unknown },
  markdown: string
) => {
  try {
    return String(processor.processSync(markdown))
  } catch (error) {
    return `!!渲染抛错 ${(error as Error).name}`
  }
}

const directivesOf = (
  processor: { parse: (markdown: string) => Node },
  markdown: string
) => {
  const found: DirectiveNode[] = []
  visit(processor.parse(markdown), (node) => {
    if (isDirective(node)) {
      found.push(node)
    }
  })
  return found
}

type Category =
  '冒号恢复' | '行内短代码变原文' | '指令写法变原文' | '空占位短代码' | '其他'

// 新管线对「中」管线解析出的一个整行 / 容器指令的处置。容器写法现在是普通文字,
// 同样算作按原文显示
function fateOf(node: DirectiveNode) {
  if (
    node.type === 'leafDirective' &&
    Object.hasOwn(KUN_DIRECTIVES, node.name)
  ) {
    const spec = KUN_DIRECTIVES[node.name as keyof typeof KUN_DIRECTIVES]
    const attributes = node.attributes ?? {}
    if (spec.parse(attributes)) {
      return 'rendered'
    }
    if (spec.blank(attributes)) {
      return 'blank'
    }
  }
  return 'restored'
}

interface SourceStats {
  rows: number
  changed: number
  categories: Record<Category, string[]>
  samples: string[]
}

const createStats = (): SourceStats => ({
  rows: 0,
  changed: 0,
  categories: {
    冒号恢复: [],
    行内短代码变原文: [],
    指令写法变原文: [],
    空占位短代码: [],
    其他: []
  },
  samples: []
})

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

// 新旧两份文字第一处不同的位置附近各取一小段
const excerpt = (before: string, after: string) => {
  let index = 0
  while (
    index < before.length &&
    index < after.length &&
    before[index] === after[index]
  ) {
    index++
  }
  const from = Math.max(0, index - 12)
  return `「${before.slice(from, index + 24)}」→「${after.slice(from, index + 36)}」`
}

const inspect = (
  stats: SourceStats,
  profile: Profile,
  id: string,
  markdown: string
) => {
  stats.rows++
  const pipelines = PIPELINES[profile]
  const before = render(pipelines.old, markdown)
  const after = render(pipelines.new, markdown)
  if (before === after) {
    return
  }
  stats.changed++

  const middle = render(pipelines.mid, markdown)
  const categories: Category[] = []

  if (before !== middle) {
    // 简介里合格的行内短代码原先画成卡片 / 播放器, 现在是原文; 其余都是文字回来了
    const inlineKun =
      profile === 'introduction' &&
      directivesOf(pipelines.old, markdown).some(
        (node) => node.type === 'textDirective' && parseLegacyKun(node)
      )
    categories.push(inlineKun ? '行内短代码变原文' : '冒号恢复')
  }
  const blanked = render(pipelines.blank, markdown)
  if (middle !== blanked) {
    // 地址没填的整行短代码不再输出空标签
    categories.push('空占位短代码')
  }
  if (blanked !== after) {
    // 名字没注册、属性填了却不合格的整行指令, 以及容器写法, 现在按原文显示
    const restored = directivesOf(pipelines.mid, markdown).some(
      (node) => fateOf(node) === 'restored'
    )
    categories.push(restored ? '指令写法变原文' : '其他')
  }

  for (const category of categories) {
    stats.categories[category].push(id)
  }
  if (stats.samples.length < SAMPLE_LIMIT) {
    stats.samples.push(
      `${id} [${categories.join(' + ')}] ${excerpt(textOf(before), textOf(after))}`
    )
  }
}

const count = (rows: { markdown: string }[], pattern: RegExp) =>
  rows.filter((row) => pattern.test(row.markdown)).length

const report = (name: string, stats: SourceStats) => {
  console.log(`\n== ${name}: ${stats.rows} 行, 输出有变化 ${stats.changed} 行`)
  for (const [category, ids] of Object.entries(stats.categories)) {
    // 需要人工处理或必须为 0 的类别列全, 其余只报数
    const list =
      category === '冒号恢复' || category === '空占位短代码' || ids.length === 0
        ? ''
        : `  ${ids.join(' ')}`
    console.log(`  ${category}: ${ids.length}${list}`)
  }
  if (stats.samples.length > 0) {
    console.log(`  样本 (至多 ${SAMPLE_LIMIT} 条, 旧 → 新):`)
    for (const sample of stats.samples) {
      console.log(`    ${sample}`)
    }
  }
}

const main = async () => {
  const comments = createStats()
  const commentRows: { markdown: string }[] = []
  for (let cursorId = 0; ;) {
    const batch = await prisma.patch_comment.findMany({
      where: { id: { gt: cursorId } },
      select: { id: true, content: true },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' }
    })
    if (batch.length === 0) {
      break
    }
    for (const row of batch) {
      commentRows.push({ markdown: row.content })
      inspect(comments, 'comment', `评论 ${row.id}`, row.content)
    }
    cursorId = batch[batch.length - 1].id
  }

  const introductions = createStats()
  const introductionRows: { markdown: string }[] = []
  for (let cursorId = 0; ;) {
    const batch = await prisma.patch.findMany({
      where: { id: { gt: cursorId } },
      select: { id: true, unique_id: true, introduction: true },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' }
    })
    if (batch.length === 0) {
      break
    }
    for (const row of batch) {
      introductionRows.push({ markdown: row.introduction })
      // 用 unique_id 标识: 站内地址就是 /<unique_id>
      inspect(
        introductions,
        'introduction',
        `/${row.unique_id}`,
        row.introduction
      )
    }
    cursorId = batch[batch.length - 1].id
  }

  report('patch_comment.content (评论)', comments)
  report('patch.introduction (游戏简介)', introductions)

  console.log('\n== 按写法计数')
  console.log(
    `  简介里的行内短代码 \`:kun-link{\` / \`:kun-video{\`: ${count(introductionRows, /(^|[^:]):kun-(link|video)[{[]/m)}`
  )
  console.log(
    `  评论里的整行短代码 \`::kun-link\` / \`::kun-video\` (评论不显示它们): ${count(commentRows, /^\s*::kun-(link|video)[{[]/m)}`
  )
  console.log(
    `  以 \`---\` 开头的简介 / 评论 (文首两行 --- 之间的内容现在不显示, 本次不改): ${count(introductionRows, /^---[ \t]*(\r?\n|$)/)} / ${count(commentRows, /^---[ \t]*(\r?\n|$)/)}`
  )

  const unexplained =
    comments.categories.其他.length + introductions.categories.其他.length
  console.log(
    unexplained === 0
      ? '\n结论: 全部差异都有成因, 可以发布'
      : `\n结论: 有 ${unexplained} 行差异解释不了 (上面的「其他」), 不要发布`
  )

  await prisma.$disconnect()
  process.exitCode = unexplained === 0 ? 0 : 1
}

void main()
