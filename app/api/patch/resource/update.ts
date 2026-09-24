import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { patchResourceUpdateSchema } from '~/validations/patch'
import { markdownToHtml } from '~/app/api/utils/render/markdownToHtml'
import {
  abandonBoundResourceObjects,
  bindUploadedResource,
  enqueueResourceLinkDeletions,
  recalcPatchType
} from './_helper'
import { invalidatePatchResourceDetailCache } from './cache'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { invalidateUserPendingResourceCache } from '~/app/api/utils/pendingResourceCache'
import { enqueueSearchOutbox, queueSearchSync } from '~/server/search/sync'
import { kickS3DeletionDrain } from '~/server/storage/s3Outbox'
import {
  MODERATION_SKIP,
  createModerationTask,
  hasPendingModeration,
  preScreenText
} from '~/server/moderation/submit'
import type { PatchResource } from '~/types/api/patch'

export const updatePatchResource = async (
  input: z.infer<typeof patchResourceUpdateSchema>,
  uid: number,
  userRole: number
) => {
  const {
    resourceId,
    patchId: inputPatchId,
    links,
    emulatorType,
    modelName,
    ...resourceData
  } = input
  // 联动字段随所选平台/类型归一: 未含对应平台/类型时不落库残值
  const emulator_type = input.platform.includes('emulator') ? emulatorType : []
  const model_name = input.type.includes('ai') ? modelName : ''
  const resource = await prisma.patch_resource.findUnique({
    where: { id: resourceId },
    include: {
      links: {
        orderBy: { sort_order: 'asc' }
      }
    }
  })
  // 隐藏 (status=1) 的资源仅后台可管理, 前端与不存在等同
  if (!resource || resource.status === 1) {
    return '未找到该资源'
  }

  if (resource.user_id !== uid && userRole < 3) {
    return '您没有权限更改该资源'
  }
  if (userRole < 3) {
    // status=2: 首个资源的人工审批流, 审批期间同样禁止修改
    if (resource.status === 2) {
      return '您发布的资源正在等待管理员审核, 暂时无法修改'
    }
    if (await hasPendingModeration('resource', { contentId: resourceId })) {
      return '您发布的资源正在审核中, 暂时无法修改'
    }
    // 待审核 (status=3) 的资源禁止修改; hasPendingModeration 之外再兜底一层
    if (resource.status === 3) {
      return '您发布的资源正在审核中, 暂时无法修改'
    }
  }

  if (inputPatchId !== resource.patch_id) {
    return '资源与 Galgame 不匹配'
  }
  const patchId = resource.patch_id
  const currentPatch = await prisma.patch.findUnique({
    where: { id: patchId },
    select: { id: true }
  })
  if (!currentPatch) {
    return '未找到该资源对应的 Galgame 信息, 请确认 Galgame 存在'
  }

  // 编辑标题/介绍/模型型号后必须重新送审; 待人工审批 (status=2) 的资源不送 AI;
  // 标题与介绍均为空的资源无文本可审, 直接放行. 预筛必须先于 S3 重绑: 预筛
  // (读审核配置) 可能因 Redis 故障抛错, 在绑定之后抛会泄漏已复制的对象
  const textChanged =
    resource.name !== input.name ||
    resource.note !== input.note ||
    resource.model_name !== model_name
  const moderationText = `标题: ${input.name}\n介绍: ${input.note}${model_name ? `\n模型型号: ${model_name}` : ''}`
  const moderation =
    resource.status === 2 ||
    !textChanged ||
    !`${input.name}${input.note}${model_name}`.trim()
      ? MODERATION_SKIP
      : await preScreenText(moderationText, userRole)

  // 阶段一 (事务外): 只完成 S3 重绑 —— copy 不进事务; 链接 diff 与删除入队推迟到
  // 行锁之下, 以锁下集合为事实源. 事务外快照与行锁之间的并发编辑是 deleteMany +
  // create 整体换行: 基于快照的 diff 会漏删并发重绑的新 s3 对象 (孤儿且公开可达),
  // 并把已入队删除的旧 key 复制回新行成悬空链接
  const snapshotLinksById = new Map(
    resource.links.map((link) => [link.id, link])
  )
  const nextLinkIds = new Set(
    links
      .map((link) => link.id)
      .filter((id): id is number => typeof id === 'number')
  )
  const boundLinks = new Map<number, { content: string; s3Key: string }>()

  // bind 抛错 (Redis/配额 DB 故障、copy 超时 rethrow) 同样泄漏历史条目: 抛错的
  // 迭代要么未创建 finalKey 要么已在 _helper 内自清, 循环级 catch 只清历史无双删
  try {
    for (const [index, link] of links.entries()) {
      if (link.storage !== 's3') {
        continue
      }
      if (link.hash) {
        const result = await bindUploadedResource(patchId, link.hash, uid)
        if (typeof result === 'string') {
          await abandonBoundResourceObjects([...boundLinks.values()], patchId)
          return result
        }
        boundLinks.set(index, {
          content: result.downloadLink,
          s3Key: result.s3Key
        })
        continue
      }
      // 保留型 s3 链接仅做资格预检, content/s3_key 在锁下解析
      const snapshotLink =
        typeof link.id === 'number' ? snapshotLinksById.get(link.id) : null
      if (!snapshotLink || snapshotLink.storage !== 's3') {
        await abandonBoundResourceObjects([...boundLinks.values()], patchId)
        return '请先上传资源文件'
      }
    }
  } catch (error) {
    await abandonBoundResourceObjects([...boundLinks.values()], patchId)
    throw error
  }

  // update 覆写前的权威行状态, 由事务内行锁读取后回填; 提交后的失效闸门读它
  // 而非事务外快照 (锁下复检保证回填必然发生, 快照初值仅满足赋值定型)
  let previousStatus = resource.status
  let previousSection = resource.section

  const updatedResourcePromise = prisma.$transaction(async (prisma) => {
    // 行锁读 update 覆写前的状态: 事务外快照与提交之间存在并发 approve (2→0) /
    // AI 审核放行 (3→0) / 隐藏 (0→1) 窗口, 用快照判定会漏失效或多失效 (64fedb7f 同型);
    // 与 moderation apply 的 FOR UPDATE 互斥, 加锁顺序 (先 patch_resource 后 patch) 与其一致
    const [previous] = await prisma.$queryRaw<
      Array<{ status: number; section: string }>
    >`SELECT status, section FROM patch_resource WHERE id = ${resourceId} FOR UPDATE`
    // 锁下复检事务外守卫: 快照与事务开始之间隔着 S3 绑定/预筛的秒级窗口, 并发的
    // 管理员隐藏 (0→1) 若不复检, 预筛拦截会把隐藏行写回待审核 (3), AI 放行 (3→0)
    // 即静默撤销管理员隐藏. 拦截型任务与 status=3 同事务写入, status 复检已覆盖
    // 并发任务, 无需重查 hasPendingModeration. 被拦时已重绑的新对象随本事务入队
    // 清理后再 return (return 字符串会提交事务, 与下方冲突分支同构): 此前无行
    // 变更, 提交的只有这份清理入队; abandon 兜底只覆盖事务 reject, 不覆盖此处
    let guardError: string | null = null
    if (!previous || previous.status === 1) {
      guardError = '未找到该资源'
    } else if (userRole < 3 && previous.status === 2) {
      guardError = '您发布的资源正在等待管理员审核, 暂时无法修改'
    } else if (userRole < 3 && previous.status === 3) {
      guardError = '您发布的资源正在审核中, 暂时无法修改'
    }
    if (guardError) {
      await enqueueResourceLinkDeletions(
        prisma,
        [...boundLinks.values()].map((item) => ({
          content: item.content,
          patchId: resource.patch_id,
          hash: '',
          s3Key: item.s3Key
        }))
      )
      return guardError
    }
    previousStatus = previous.status
    previousSection = previous.section

    // 阶段二 (锁下): 重读 links 并重算 diff, 删除入队与保留型链接的 content/s3_key
    // 都以行锁下的当前集合为准 (deleteMany 即将带走的正是这个集合)
    const currentLinks = await prisma.patch_resource_link.findMany({
      where: { resource_id: resourceId }
    })
    const currentLinksById = new Map(
      currentLinks.map((link) => [link.id, link])
    )

    const s3LinksToDelete: Array<{
      content: string
      patchId: number
      hash: string
      s3Key: string
    }> = []
    // 未被保留的行 (含并发编辑产生的新行): 其 s3 对象随 deleteMany 一并入队
    for (const removedLink of currentLinks) {
      if (!nextLinkIds.has(removedLink.id) && removedLink.storage === 's3') {
        s3LinksToDelete.push({
          content: removedLink.content,
          patchId: resource.patch_id,
          hash: removedLink.hash,
          s3Key: removedLink.s3_key
        })
      }
    }

    const preparedLinks: Array<{
      storage: string
      size: string
      code: string
      password: string
      hash: string
      s3_key: string
      content: string
      sort_order: number
      download: number
    }> = []
    for (const [index, link] of links.entries()) {
      const existingLink =
        typeof link.id === 'number' ? currentLinksById.get(link.id) : null
      const bound = boundLinks.get(index)

      let content = link.content
      let s3Key = ''
      if (link.storage === 's3') {
        if (bound) {
          content = bound.content
          s3Key = bound.s3Key
        } else if (existingLink && existingLink.storage === 's3') {
          content = existingLink.content
          s3Key = existingLink.s3_key
        } else {
          // 资格预检通过但锁下行已被并发编辑重建: 本次编辑的语义基础已失效.
          // 已重绑的新对象随本事务入队清理 —— return 字符串会提交事务, 此前
          // 无任何行变更, 提交的只有这份清理入队; 上传暂存仍在, 重试可再次绑定
          await enqueueResourceLinkDeletions(
            prisma,
            [...boundLinks.values()].map((item) => ({
              content: item.content,
              patchId: resource.patch_id,
              hash: '',
              s3Key: item.s3Key
            }))
          )
          return '该资源的链接已被修改, 请刷新后重试'
        }
      }

      if (
        existingLink &&
        existingLink.storage === 's3' &&
        (link.storage !== 's3' || bound)
      ) {
        s3LinksToDelete.push({
          content: existingLink.content,
          patchId: resource.patch_id,
          hash: existingLink.hash,
          s3Key: existingLink.s3_key
        })
      }

      preparedLinks.push({
        storage: link.storage,
        size: link.size,
        code: link.code,
        password: link.password,
        hash: link.storage === 's3' ? '' : link.hash,
        s3_key: s3Key,
        content,
        sort_order: index,
        download: existingLink?.download ?? 0
      })
    }

    const newResource = await prisma.patch_resource.update({
      where: { id: resourceId },
      data: {
        ...resourceData,
        emulator_type,
        model_name,
        ...(moderation.intercept ? { status: 3 } : {}),
        links: {
          deleteMany: {},
          create: preparedLinks
        }
      },
      include: {
        user: {
          include: {
            _count: {
              select: { patch_resource: true }
            }
          }
        },
        patch: {
          select: {
            unique_id: true
          }
        },
        links: {
          orderBy: { sort_order: 'asc' }
        }
      }
    })

    await prisma.patch.update({
      where: { id: patchId },
      data: { resource_update_time: new Date() }
    })
    await recalcPatchType(patchId, prisma)
    // 事务性入队：与补丁变更原子提交，关闭崩溃丢失窗口
    await enqueueSearchOutbox(prisma, patchId)
    // 事务性入队 S3 删除 (被移除/重绑的旧链接)：与行变更原子提交，取代提交后
    // Promise.all 的不可恢复删除
    await enqueueResourceLinkDeletions(prisma, s3LinksToDelete)

    if (moderation.queue) {
      await createModerationTask(
        {
          contentType: 'resource',
          contentId: resourceId,
          // 分组用资源真实 patch_id (与 apply 的 recalcPatchType 对齐, 防 input 篡改失准)
          patchId: resource.patch_id,
          userId: resource.user_id,
          payload: {
            text: moderationText,
            name: newResource.name
          },
          dryRun: moderation.dryRun
        },
        prisma
      )
    }

    const resourceResponse: PatchResource = {
      id: newResource.id,
      name: newResource.name,
      section: newResource.section,
      uniqueId: newResource.patch.unique_id,
      type: newResource.type,
      language: newResource.language,
      note: newResource.note,
      noteHtml: newResource.note ? await markdownToHtml(newResource.note) : '',
      platform: newResource.platform,
      emulatorType: newResource.emulator_type,
      modelName: newResource.model_name,
      download: newResource.download,
      links: newResource.links.map((link) => ({
        id: link.id,
        storage: link.storage,
        size: link.size,
        code: link.code,
        password: link.password,
        hash: link.hash,
        content: link.content,
        sortOrder: link.sort_order,
        download: link.download
      })),
      likeCount: 0,
      isLike: false,
      status: newResource.status,
      userId: newResource.user_id,
      patchId: newResource.patch_id,
      created: String(newResource.created),
      user: {
        id: newResource.user.id,
        name: newResource.user.name,
        avatar: newResource.user.avatar,
        patchCount: newResource.user._count.patch_resource,
        role: newResource.user.role
      }
    }

    return resourceResponse
  })
  // 事务抛错回滚会连带撤销冲突分支的事务内清理入队: 已重绑对象在此兜底清理
  const updatedResource = await updatedResourcePromise.catch(
    async (error: unknown) => {
      await abandonBoundResourceObjects([...boundLinks.values()], patchId)
      throw error
    }
  )
  if (typeof updatedResource === 'string') {
    return updatedResource
  }

  queueSearchSync(patchId)
  // 事务提交后失效: 事务内失效会被并发读回填旧值 (M-04), 且 Redis 故障不应回滚写入
  await invalidatePatchContentCache(updatedResource.uniqueId).catch(
    () => undefined
  )

  const wasPublic = previousStatus === 0
  const isPublic = updatedResource.status === 0
  if (wasPublic || isPublic) {
    await invalidatePatchResourceDetailCache(patchId)
  }

  const wasListed = wasPublic && previousSection === 'patch'
  const isListed = isPublic && updatedResource.section === 'patch'
  if (wasListed || isListed) {
    await invalidateResourceListCache()
  }

  // 编辑触发审核拦截 (0→3): 作者的 hasPendingResource 由 false 翻真, 立即失效
  if (previousStatus !== 3 && updatedResource.status === 3) {
    await invalidateUserPendingResourceCache(resource.user_id)
  }

  // 即时消费删除出箱；抢不到锁则由定时任务兜底
  kickS3DeletionDrain()

  return updatedResource
}
