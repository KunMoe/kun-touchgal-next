import { Prisma } from '~/prisma/generated/prisma/client'
import { can } from '~/constants/permission'
import { isPendingPhase, statusesOf } from '~/constants/contentStatus'
import { visiblePhases } from '~/utils/content/policy'
import type { ContentKind } from '~/constants/contentStatus'
import type { ContentViewer } from '~/utils/content/policy'

// 读侧的可见性谓词: Prisma 与原生 SQL 两种方言都由 utils/content/policy.ts 的 visiblePhases
// 生成, 口径只在那里定。只在服务端用 (原生 SQL 要 Prisma 运行时)

// 状态码以字面量进 SQL, 不当绑定参数: 文本与改用常量之前逐字相同, 计划与 SQL 形状测试都不变。
// 入参只来自 constants/contentStatus.ts 的常量 (数字), 没有注入面
export const statusSql = (...codes: number[]) => Prisma.raw(codes.join(', '))

const statusIs = (codes: number[]) =>
  codes.length === 1 ? codes[0] : { in: codes }

const visibleStatuses = (kind: ContentKind, viewer: ContentViewer | null) => ({
  // 作者以外的人看得到的
  anyone: statusesOf(kind, visiblePhases(viewer, false)),
  // 作者本人才多看到的那几种
  ownerOnly: statusesOf(
    kind,
    visiblePhases(viewer, true).filter(isPendingPhase)
  )
})

// 对 viewer 可见的行。看得到他人待审内容的人只按状态筛; 登录用户还看得到自己的待审内容
export const visibleWhere = (
  kind: ContentKind,
  viewer: ContentViewer | null
) => {
  const { anyone, ownerOnly } = visibleStatuses(kind, viewer)
  if (can(viewer, 'content.viewPending') || !viewer || viewer.uid <= 0) {
    return { status: statusIs(anyone) }
  }
  return {
    OR: [
      { status: statusIs(anyone) },
      { status: statusIs(ownerOnly), user_id: viewer.uid }
    ]
  }
}

const statusMatchSql = (column: Prisma.Sql, codes: number[]) =>
  codes.length === 1
    ? Prisma.sql`${column} = ${statusSql(codes[0])}`
    : Prisma.sql`${column} IN (${statusSql(...codes)})`

// 原生 SQL 方言, 列名必须带表别名 (alias 是封闭的字面量, 没有注入面)
export const visibleSql = (
  kind: ContentKind,
  viewer: ContentViewer | null,
  alias: 'patch_comment' | 'pc'
) => {
  const { anyone, ownerOnly } = visibleStatuses(kind, viewer)
  const status = Prisma.raw(`${alias}.status`)
  if (can(viewer, 'content.viewPending')) {
    return statusMatchSql(status, anyone)
  }
  // 游客也走这一支: uid 0 不匹配任何作者
  return Prisma.sql`(${statusMatchSql(status, anyone)} OR (${statusMatchSql(status, ownerOnly)} AND ${Prisma.raw(`${alias}.user_id`)} = ${viewer?.uid ?? 0}))`
}
