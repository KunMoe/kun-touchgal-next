import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { lockPatchRows } from '~/server/content/patchLock'
import { patchUpdateSchema } from '~/validations/edit'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { processSubmittedExternalData } from './processExternalData'
import { queueSearchSync, enqueueSearchOutbox } from '~/server/search/sync'
import {
  GALGAME_EDIT_SELECT,
  galgameEditFieldsFromRow,
  galgameEditFingerprint,
  normalizeGalgameEditInput,
  normalizeGalgameExternalIds
} from './_editFields'

export const updateGalgame = async (
  input: z.infer<typeof patchUpdateSchema>,
  uid: number
) => {
  const {
    vndbId: normalizedVndbId,
    vndbRelationId: normalizedVndbRelationId,
    bangumiId: normalizedBangumiId,
    steamId: normalizedSteamId,
    dlsiteCode: normalizedDlsiteCode
  } = normalizeGalgameExternalIds(input)

  // 存在性检查与四条外部 ID 预检互不依赖, 并行发出 (与 create.ts 同形态); 并发
  // 兜底靠唯一索引 + 下方事务的 P2002 回退, 预检只负责给出可读的业务错误
  const [patch, vndbPatch, dlsitePatch, bangumiPatch, steamPatch] =
    await Promise.all([
      prisma.patch.findUnique({
        where: { id: input.id },
        select: { unique_id: true }
      }),
      // 查询与即将写入的 (vndb_id, vndb_relation_id) 形态完全一致的行(空值按 null
      // 匹配): 单独 vndb_id / 单独 relation_id 也不允许重复, 但同 vndb_id 不同
      // relation 的共存不受影响. 并发兜底除组合唯一索引外还有两个 schema 无法声明的
      // 部分唯一索引, 见 db/migrations/0007_patch_vndb_solo_unique.notx.sql
      normalizedVndbId || normalizedVndbRelationId
        ? prisma.patch.findFirst({
            where: {
              vndb_id: normalizedVndbId ? normalizedVndbId : null,
              vndb_relation_id: normalizedVndbRelationId
                ? normalizedVndbRelationId
                : null
            },
            select: { id: true, unique_id: true }
          })
        : null,
      normalizedDlsiteCode
        ? prisma.patch.findFirst({
            where: { dlsite_code: normalizedDlsiteCode },
            select: { id: true, unique_id: true }
          })
        : null,
      normalizedBangumiId !== null
        ? prisma.patch.findFirst({
            where: { bangumi_id: normalizedBangumiId },
            select: { id: true, unique_id: true }
          })
        : null,
      normalizedSteamId !== null
        ? prisma.patch.findFirst({
            where: { steam_id: normalizedSteamId },
            select: { id: true, unique_id: true }
          })
        : null
    ])
  if (!patch) {
    return '该 ID 下未找到对应 Galgame'
  }
  // 占用方是自身时不算重复 (编辑不改外部 ID 的常态)
  if (vndbPatch && vndbPatch.id !== input.id) {
    if (normalizedVndbId && normalizedVndbRelationId) {
      return `Galgame VNDB ID 与 Relation ID 的组合与游戏 ID 为 ${vndbPatch.unique_id} 的游戏重复`
    }
    return normalizedVndbId
      ? `Galgame VNDB ID 与游戏 ID 为 ${vndbPatch.unique_id} 的游戏重复`
      : `Galgame VNDB Relation ID 与游戏 ID 为 ${vndbPatch.unique_id} 的游戏重复`
  }
  if (dlsitePatch && dlsitePatch.id !== input.id) {
    return `Galgame DLSite Code 与游戏 ID 为 ${dlsitePatch.unique_id} 的游戏重复`
  }
  if (bangumiPatch && bangumiPatch.id !== input.id) {
    return `Galgame Bangumi ID 与游戏 ID 为 ${bangumiPatch.unique_id} 的游戏重复`
  }
  if (steamPatch && steamPatch.id !== input.id) {
    return `Galgame Steam ID 与游戏 ID 为 ${steamPatch.unique_id} 的游戏重复`
  }

  const {
    id,
    dlsiteCircleName,
    dlsiteCircleLink,
    vndbTags,
    vndbDevelopers,
    bangumiTags,
    bangumiDevelopers,
    steamTags,
    steamDevelopers,
    dlsiteTags,
    removeTagIds,
    addTagNames,
    baseFingerprint
  } = input

  // patch 字段、别名与写出箱入队在同一个事务里提交: 别名整份替换不再另开事务, 冲突或撞
  // 唯一索引时两者一起回滚
  const updateResult = await kunTx(
    'edit.update',
    async ({ tx, fail }) => {
      // 先锁 patch 行再读: 当前值要在锁下读到才作数, 否则另一次保存可以夹在读与写之间。
      // 别名只在这把锁下整份替换, 锁序固定为 patch 行 → patch_alias
      await lockPatchRows(tx, [id])
      const stored = await tx.patch.findUnique({
        where: { id },
        select: GALGAME_EDIT_SELECT
      })
      if (!stored) {
        return fail('该 ID 下未找到对应 Galgame')
      }

      const storedFields = galgameEditFieldsFromRow(stored)
      const next = normalizeGalgameEditInput({
        ...input,
        // released 缺省即不动, 以库里的值参与比较
        released: input.released ?? storedFields.released
      })
      // 库里的值既不是表单打开时读到的那一份, 也不是这次要写的那一份: 期间有人改过, 照写
      // 会把对方的修改悄悄盖掉。等于这次要写的那一份时放行: 那是上一次提交的主事务已落库、
      // 后面的标签步骤失败之后的重试, 拦下它用户就只能看到冲突提示。标签差量可交换, 不进指纹
      const current = galgameEditFingerprint(storedFields)
      if (
        current !== baseFingerprint &&
        current !== galgameEditFingerprint(next)
      ) {
        return fail('该游戏已被他人修改, 请刷新后重试')
      }

      await tx.patch.update({
        where: { id },
        data: {
          name: next.name,
          vndb_id: next.vndbId,
          vndb_relation_id: next.vndbRelationId,
          bangumi_id: next.bangumiId,
          steam_id: next.steamId,
          dlsite_code: next.dlsiteCode,
          introduction: next.introduction,
          content_limit: next.contentLimit,
          released: next.released
        }
      })

      await tx.patch_alias.deleteMany({
        where: { patch_id: id }
      })
      // 批内去重已由 normalizeGalgameEditInput 做掉; patch_alias 无 (patch_id, name) 唯一
      // 约束, skipDuplicates 在这里是空操作, 照旧留着
      await tx.patch_alias.createMany({
        data: next.alias.map((name) => ({ name, patch_id: id })),
        skipDuplicates: true
      })

      // 事务性入队：patch 字段更新与写出箱入队原子提交，关闭崩溃丢失窗口
      await enqueueSearchOutbox(tx, id)
    },
    {
      // bangumi_id / steam_id / dlsite_code / (vndb_id, vndb_relation_id) 组合及其
      // 单独形态部分唯一索引 (db/migrations/0007_patch_vndb_solo_unique.notx.sql) 兜底并发编辑:
      // 预检与 patch.update 之间两个填同一外部 ID 的请求会双双通过预检.
      // 撞索引时事务回滚, 以这句文案作为结果
      violations: {
        P2002: '您填写的外部 ID 已经被其它 Galgame 使用, 请检查后重试'
      }
    }
  )

  if (typeof updateResult === 'string') {
    return updateResult
  }

  await processSubmittedExternalData(
    id,
    {
      vndbTags: vndbTags ?? [],
      vndbDevelopers: vndbDevelopers ?? [],
      bangumiTags: bangumiTags ?? [],
      bangumiDevelopers: bangumiDevelopers ?? [],
      steamTags: steamTags ?? [],
      steamDevelopers: steamDevelopers ?? [],
      dlsiteTags: dlsiteTags ?? [],
      dlsiteCircleName: dlsiteCircleName ?? '',
      dlsiteCircleLink: dlsiteCircleLink ?? ''
    },
    { removeTagIds, addTagNames },
    uid
  )

  queueSearchSync(id)

  try {
    await invalidatePatchContentCache(patch.unique_id)
  } catch {
    // 缓存失效失败不影响编辑结果
  }

  return {}
}
