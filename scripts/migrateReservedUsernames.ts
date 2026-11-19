import { prisma } from '~/prisma/index'
import { redis } from '~/lib/redis'
import { isReservedUsername } from '~/constants/reserved-usernames.server'
import { finishKunSecurityEvent } from '~/server/auth/securityEvents'

// 一次性迁移: 将用户名命中保留词表的存量用户统一改名为「用户{id}」。
// 默认 dry-run 只打印清单; 加 --apply 才写库。存量保留名用户里含 uid 1
// (超管本人) 与冒名的 admin (见 app/api/admin/user/update.ts), 合法持有者
// 用 --exclude=1,2 排除。
//   pnpm exec esno scripts/migrateReservedUsernames.ts
//   pnpm exec esno scripts/migrateReservedUsernames.ts --apply --exclude=1

const BATCH_SIZE = 500

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const excludeArg = args.find((arg) => arg.startsWith('--exclude='))
const excludedIds = new Set(
  excludeArg
    ? excludeArg
        .slice('--exclude='.length)
        .split(',')
        .map(Number)
        .filter(Number.isInteger)
    : []
)

const migrateReservedUsernames = async () => {
  const hits: { id: number; name: string; role: number }[] = []
  let cursorId = 0

  while (true) {
    const batch = await prisma.user.findMany({
      where: { id: { gt: cursorId } },
      select: { id: true, name: true, role: true },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' }
    })
    if (batch.length === 0) {
      break
    }
    for (const user of batch) {
      if (isReservedUsername(user.name)) {
        hits.push(user)
      }
      cursorId = user.id
    }
  }

  console.log(`[migrate] 命中保留词的用户共 ${hits.length} 个`)

  let renamed = 0
  let skipped = 0
  let failed = 0

  for (const user of hits) {
    const target = `用户${user.id}`
    const label = `id=${user.id} role=${user.role} "${user.name}" -> "${target}"`

    if (excludedIds.has(user.id)) {
      skipped++
      console.log(`[skip] ${label} (在 --exclude 列表中)`)
      continue
    }

    // name 是 @unique, 目标名可能恰好已被他人占用, 占用则跳过人工处理
    const occupant = await prisma.user.findUnique({
      where: { name: target },
      select: { id: true }
    })
    if (occupant) {
      skipped++
      console.log(`[skip] ${label} (目标名已被 id=${occupant.id} 占用)`)
      continue
    }

    if (!apply) {
      console.log(`[dry-run] ${label}`)
      continue
    }

    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { name: target }
      })
      renamed++
      console.log(`[renamed] ${label}`)
    } catch (error) {
      failed++
      console.error(`[failed] ${label}`, error)
      continue
    }
    // JWT payload 携带 name, 照抄管理端改名路径硬删旧 token 使其重新登录。
    // 与改名分开 catch: 此处失败改名已生效, 旧 token 的 name 会在刷新时自愈
    await finishKunSecurityEvent(user.id, 'username-reserved-migrated').catch(
      (error) => {
        console.warn(`[warn] id=${user.id} 改名成功但删除旧 token 失败`, error)
      }
    )
  }

  if (apply) {
    console.log(
      `[migrate] 完成: renamed=${renamed}, skipped=${skipped}, failed=${failed}`
    )
  } else {
    console.log(
      `[migrate] dry-run 结束 (未写库), 待改 ${hits.length - skipped} 个, skipped=${skipped}; 加 --apply 执行`
    )
  }
}

migrateReservedUsernames()
  .catch((error) => {
    console.error('[migrate] fatal:', error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    // lazyConnect 的 redis 一旦被 deleteKunToken 触发建连, 不断开进程不退出
    redis.disconnect()
  })
