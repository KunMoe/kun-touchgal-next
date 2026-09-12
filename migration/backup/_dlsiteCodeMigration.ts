import 'dotenv/config'
import { prisma } from '~/prisma/index'
import { fetchDlsiteData } from '~/lib/arnebiae/dlsite'
import { invalidateCompanyListCache } from '~/app/api/company/cache'
import { handleBatchPatchTags } from '~/app/api/edit/batchTag'

const DLSITE_LINK_REGEX =
  /::kun-link\{[^}]*href="https:\/\/www\.dlsite\.com\/[^"]*product_id\/([A-Za-z0-9]+)\.html\/?"[^}]*\}/i

const parseDlsiteTags = (raw?: string) => {
  if (!raw) return [] as string[]
  return raw
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

const unique = <T>(arr: T[]) => Array.from(new Set(arr))

// 原 app/api/edit/dlsite.ts 的 ensurePatchCompanyFromDlsite; 生产路径已改走
// app/api/patch/introduction/company/_gatherCompanies.ts, 仅本脚本使用, 随归档内联
const ensurePatchCompanyFromDlsite = async (
  patchId: number,
  dlsiteCode: string | null | undefined,
  uid: number
) => {
  const code = dlsiteCode?.trim()
  if (!code) return

  try {
    const data = await fetchDlsiteData(code)
    const circleName = data.circle_name?.trim() ?? ''
    const circleLink = data.circle_link?.trim() ?? ''

    if (!circleName) return
    let changed = false

    let company = await prisma.patch_company.findFirst({
      where: { name: circleName }
    })

    if (!company) {
      // skipDuplicates 依赖 patch_company_name_key 唯一索引兜底并发创建
      const created = await prisma.patch_company.createMany({
        data: [
          {
            name: circleName,
            introduction: '',
            count: 0,
            primary_language: [],
            official_website: circleLink ? [circleLink] : [],
            parent_brand: [],
            alias: [],
            user_id: uid
          }
        ],
        skipDuplicates: true
      })
      if (created.count) {
        changed = true
      }
      company = await prisma.patch_company.findFirst({
        where: { name: circleName }
      })
    }

    if (!company) return

    const insertedRelation = await prisma.patch_company_relation.createMany({
      data: [{ patch_id: patchId, company_id: company.id }],
      skipDuplicates: true
    })

    if (insertedRelation.count) {
      changed = true
    }

    if (changed) {
      await invalidateCompanyListCache()
    }
  } catch {
    // 忽略同步失败，避免阻塞主流程
  }
}

async function migrateDlsiteCodes() {
  const patches = await prisma.patch.findMany({
    where: {
      introduction: {
        contains: 'dlsite.com'
      }
    },
    include: {
      alias: true,
      tag: {
        include: {
          tag: true
        }
      }
    }
  })

  console.log(`Found ${patches.length} patches containing dlsite links`)
  let successCount = 0
  let skipped = 0

  const processPatch = async (patch: (typeof patches)[number]) => {
    if (patch.dlsite_code) {
      skipped++
      return
    }

    const match = patch.introduction.match(DLSITE_LINK_REGEX)
    if (!match) {
      skipped++
      return
    }

    const code = match[1]?.toUpperCase()
    if (!code) {
      skipped++
      return
    }

    try {
      const dlsiteData = await fetchDlsiteData(code)
      const aliasNames = new Set(
        patch.alias.map((alias) => alias.name.trim()).filter(Boolean)
      )

      const aliasesToInsert = unique(
        [dlsiteData.title_jp, dlsiteData.title_en]
          .map((title) => title?.trim())
          .filter((title): title is string => !!title && !aliasNames.has(title))
      )

      if (aliasesToInsert.length) {
        await prisma.patch_alias.createMany({
          data: aliasesToInsert.map((name) => ({
            patch_id: patch.id,
            name
          })),
          skipDuplicates: true
        })
      }

      const dlsiteTags = parseDlsiteTags(dlsiteData.tags)
      const existingTags = patch.tag.map((relation) => relation.tag.name)
      const mergedTags = unique([...existingTags, ...dlsiteTags])
      if (mergedTags.length) {
        await handleBatchPatchTags(patch.id, mergedTags, patch.user_id)
      }

      await prisma.patch.update({
        where: { id: patch.id },
        data: {
          dlsite_code: code,
          released:
            patch.released === 'unknown' && dlsiteData.release_date
              ? dlsiteData.release_date
              : patch.released
        }
      })

      await ensurePatchCompanyFromDlsite(patch.id, code, patch.user_id)

      successCount++
      console.log(
        `Updated patch ${patch.unique_id} with DLSite code ${code}, aliases +${aliasesToInsert.length}, tags ${mergedTags.length}`
      )
    } catch (error) {
      console.error(
        `Failed to process patch ${patch.unique_id} with code ${code}:`,
        error
      )
    }
  }

  const concurrency = 10
  let currentIndex = 0

  const worker = async () => {
    while (true) {
      const index = currentIndex++
      if (index >= patches.length) break
      await processPatch(patches[index])
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  console.log(
    `Migration completed. Success: ${successCount}, skipped (no code or already set): ${skipped}`
  )
}

migrateDlsiteCodes()
  .catch((error) => {
    console.error('Migration failed:', error)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
