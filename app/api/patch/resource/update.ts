import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { patchResourceUpdateSchema } from '~/validations/patch'
import {
  abandonBoundResourceObjects,
  bindUploadedResource,
  enqueueResourceLinkDeletions,
  recalcPatchType
} from './_helper'
import { enqueueSearchOutbox, queueSearchSync } from '~/server/search/sync'
import { kickS3DeletionDrain } from '~/server/storage/s3Outbox'
import {
  MODERATION_SKIP,
  enqueueTextModeration,
  hasPendingModeration,
  planTextModeration
} from '~/server/moderation/submit'
import {
  resourceSubject,
  submittedLinkSubject
} from '~/server/moderation/subject'
import { renderKunMarkdownForWrite } from '~/app/api/utils/render/renderKunMarkdown'
import { RESOURCE_STATUS } from '~/constants/contentStatus'
import { markResourcePendingReview } from '~/server/content/resource/edit'
import { linkStorageGateError } from './storageGate'
import { kunTx } from '~/server/db/tx'
import { recordKunChanges } from '~/server/cache/publish'
import { formatResourceSize } from '~/utils/resourceSize'
import type { ResourceStatus } from '~/constants/contentStatus'
import type { PatchResource } from '~/types/api/patch'
import type { KunActor } from '~/constants/role'
import type { KunTxContext } from '~/server/db/tx'
import { decideContentAction, pendingTaskBlocks } from '~/utils/content/policy'

// front: 前台入口, 按 utils/content/policy.ts 判 (作者只能改自己已上线的资源, 管理员还可以
// 改待初审、待审核的, 隐藏的与不存在等同)。admin: 后台入口, 可以编辑任何状态的资源,
// 包括隐藏的 (编辑后仍是隐藏)。同一条规则在事务外的快照上判一次, 在行锁下再判一次
export type ResourceEditScope = 'front' | 'admin'

const resourceEditError = (
  scope: ResourceEditScope,
  row: { status: number; user_id: number },
  actor: KunActor,
  pendingTask = false
) => {
  if (scope === 'admin') {
    return null
  }
  const decision = decideContentAction('resource', row, actor, 'edit', {
    pendingTask
  })
  return decision.ok ? null : decision.message
}

export const updatePatchResource = async (
  input: z.infer<typeof patchResourceUpdateSchema>,
  actor: KunActor,
  scope: ResourceEditScope
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
  if (!resource) {
    return '未找到该资源'
  }
  const pendingTask =
    scope === 'front' &&
    pendingTaskBlocks(actor) &&
    (await hasPendingModeration('resource', { contentId: resourceId }))
  const snapshotError = resourceEditError(scope, resource, actor, pendingTask)
  if (snapshotError) {
    return snapshotError
  }

  if (inputPatchId !== resource.patch_id) {
    return '资源与 Galgame 不匹配'
  }
  // 对照编辑前的分区与链接: 原样带回的存量链接不判, 所以管理员能保存含既有 TouchGal
  // 链接的资源。这里判的是事务外快照, 为的是赶在下面的 S3 重绑之前拦下; 行锁下还要再判一次
  const storageError = linkStorageGateError(
    actor,
    { section: input.section, links },
    { section: resource.section, links: resource.links }
  )
  if (storageError) {
    return storageError
  }
  const patchId = resource.patch_id
  const currentPatch = await prisma.patch.findUnique({
    where: { id: patchId },
    select: { id: true }
  })
  if (!currentPatch) {
    return '未找到该资源对应的 Galgame 信息, 请确认 Galgame 存在'
  }

  // 渲染不出来的备注在落库前拒绝 (只检查: 备注的 HTML 不落库, 详情页读时渲染)
  const renderable = await renderKunMarkdownForWrite('note', input.note)
  if (typeof renderable === 'string') {
    return renderable
  }

  const snapshotLinksById = new Map(
    resource.links.map((link) => [link.id, link])
  )
  // 沿用原文件的对象存储链接, 库里那一行的大小 (见 submittedLinkSubject)
  const keptSize = (id: number | undefined) => {
    const snapshotLink =
      id === undefined ? undefined : snapshotLinksById.get(id)
    return snapshotLink?.storage === 's3' ? snapshotLink.size : ''
  }

  // 送审字段 (见 resourceSubject 的策略表) 有变化就必须重新送审; 待人工审批
  // (status=2) 的资源不送 AI; 全空的资源无文本可审, 直接放行. 预筛必须先于 S3 重绑:
  // 预筛 (读审核配置) 可能因 Redis 故障抛错, 在绑定之后抛会泄漏已复制的对象
  const moderation =
    resource.status === RESOURCE_STATUS.awaitingApproval
      ? MODERATION_SKIP
      : await planTextModeration(
          resourceSubject({
            name: input.name,
            note: input.note,
            modelName: model_name,
            links: links.map((link) =>
              submittedLinkSubject(link, keptSize(link.id))
            )
          }),
          {
            actor,
            previous: resourceSubject({
              name: resource.name,
              note: resource.note,
              modelName: resource.model_name,
              links: resource.links
            })
          }
        )
  if (typeof moderation === 'string') {
    return moderation
  }

  // 阶段一 (事务外): 只完成 S3 重绑 —— copy 不进事务; 链接 diff 与删除入队推迟到
  // 行锁之下, 以锁下集合为事实源. 事务外快照与行锁之间的并发编辑是 deleteMany +
  // create 整体换行: 基于快照的 diff 会漏删并发重绑的新 s3 对象 (孤儿且公开可达),
  // 并把已入队删除的旧 key 复制回新行成悬空链接
  const nextLinkIds = new Set(
    links
      .map((link) => link.id)
      .filter((id): id is number => typeof id === 'number')
  )
  const boundLinks = new Map<
    number,
    { content: string; s3Key: string; size: string }
  >()
  // 清理已重绑的对象只凭它们的 key
  const boundObjects = () =>
    [...boundLinks.values()].map(({ s3Key }) => ({ s3Key }))

  // bind 抛错 (Redis/配额 DB 故障、copy 超时 rethrow) 同样泄漏历史条目: 抛错的
  // 迭代要么未创建 finalKey 要么已在 _helper 内自清, 循环级 catch 只清历史无双删
  try {
    for (const [index, link] of links.entries()) {
      if (link.storage !== 's3') {
        continue
      }
      // 带着 uploadToken 才绑定 (新加的链接, 或给已有的链接换文件); 不带就是沿用原文件
      if (link.uploadToken) {
        const result = await bindUploadedResource(
          patchId,
          link.uploadToken,
          actor.uid
        )
        if (typeof result === 'string') {
          await abandonBoundResourceObjects(boundObjects())
          return result
        }
        boundLinks.set(index, {
          content: result.downloadLink,
          s3Key: result.s3Key,
          size: formatResourceSize(result.size)
        })
        continue
      }
      // 沿用原文件的链接只做资格预检 (必须是库里已有的对象存储行),
      // content / s3_key / size / hash 在锁下解析
      const snapshotLink =
        link.id === undefined ? undefined : snapshotLinksById.get(link.id)
      if (!snapshotLink || snapshotLink.storage !== 's3') {
        await abandonBoundResourceObjects(boundObjects())
        return '请先上传资源文件'
      }
    }
  } catch (error) {
    await abandonBoundResourceObjects(boundObjects())
    throw error
  }

  // 回调单独成句, 不写进 kunTx 的参数里: 带着选项内联的话 prettier 会把整段事务体重缩进
  const updateInTx = async (ctx: KunTxContext) => {
    const { tx: prisma } = ctx
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
    // 清理, 以 commitWith 提交 (与下方冲突分支同构): 此前无行变更, 提交的只有这份
    // 清理入队; abandon 兜底只在没有提交时执行, 不覆盖此处
    // 作者不会变, 锁下只需复检状态
    const guardError = previous
      ? resourceEditError(
          scope,
          { status: previous.status, user_id: resource.user_id },
          actor
        )
      : '未找到该资源'
    if (!previous || guardError) {
      await enqueueResourceLinkDeletions(prisma, boundObjects())
      return ctx.commitWith(guardError ?? '未找到该资源')
    }

    // 阶段二 (锁下): 重读 links 并重算 diff, 删除入队与保留型链接的 content/s3_key
    // 都以行锁下的当前集合为准 (deleteMany 即将带走的正是这个集合)
    const currentLinks = await prisma.patch_resource_link.findMany({
      where: { resource_id: resourceId }
    })
    const currentLinksById = new Map(
      currentLinks.map((link) => [link.id, link])
    )

    // 存储闸门以锁下的集合为准再判一次: 快照之后别人可能删掉或换掉了这些链接, 带着旧 id
    // 回来的就不再是原样带回的存量。被拦时已重绑的新对象随本事务入队清理 (与上面的守卫
    // 复检同构)
    const lockedStorageError = linkStorageGateError(
      actor,
      { section: input.section, links },
      { section: previous.section, links: currentLinks }
    )
    if (lockedStorageError) {
      await enqueueResourceLinkDeletions(prisma, boundObjects())
      return ctx.commitWith(lockedStorageError)
    }

    const s3LinksToDelete: Array<{ s3Key: string }> = []
    // 未被保留的行 (含并发编辑产生的新行): 其 s3 对象随 deleteMany 一并入队
    for (const removedLink of currentLinks) {
      if (!nextLinkIds.has(removedLink.id) && removedLink.storage === 's3') {
        s3LinksToDelete.push({ s3Key: removedLink.s3_key })
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

      // 请求里能落到链接行上的只有外链的地址与大小, 以及两种形态都有的提取码与解压码。
      // hash 列从不取自请求: 新行与外链为空, 沿用原文件的行照锁下的值原样带过去
      let content: string
      let size: string
      let s3Key = ''
      let hash = ''
      if (link.storage !== 's3') {
        content = link.content
        size = link.size
      } else if (bound) {
        content = bound.content
        size = bound.size
        s3Key = bound.s3Key
      } else if (existingLink && existingLink.storage === 's3') {
        content = existingLink.content
        size = existingLink.size
        s3Key = existingLink.s3_key
        // 历史对象的校验码: 只读展示与后台搜索用, 原样带过去
        hash = existingLink.hash
      } else {
        // 资格预检通过但锁下行已被并发编辑重建: 本次编辑的语义基础已失效.
        // 已重绑的新对象随本事务入队清理 —— 以 commitWith 提交, 此前
        // 无任何行变更, 提交的只有这份清理入队; 上传暂存仍在, 重试可再次绑定
        await enqueueResourceLinkDeletions(prisma, boundObjects())
        return ctx.commitWith('该资源的链接已被修改, 请刷新后重试')
      }

      if (
        existingLink &&
        existingLink.storage === 's3' &&
        (link.storage !== 's3' || bound)
      ) {
        s3LinksToDelete.push({ s3Key: existingLink.s3_key })
      }

      preparedLinks.push({
        storage: link.storage,
        size,
        code: link.code,
        password: link.password,
        hash,
        s3_key: s3Key,
        content,
        sort_order: index,
        download: existingLink?.download ?? 0
      })
    }

    const newResource = await prisma.patch_resource.update({
      where: { id: resourceId },
      // 逐字段列出, 不展开 resourceData: 校验结构以后新增的字段不会不经意落库
      // (kun/inv-content-06 要求 status 键在写入体里字面可见)
      data: {
        section: resourceData.section,
        name: resourceData.name,
        note: resourceData.note,
        type: resourceData.type,
        language: resourceData.language,
        platform: resourceData.platform,
        emulator_type,
        model_name,
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

    // 被审核拦截的编辑把资源转为待审核。须在重算聚合之前: 重算只读公开资源
    const status = moderation.intercept
      ? (await markResourcePendingReview(prisma, resourceId)).status
      : newResource.status

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
      await enqueueTextModeration(prisma, moderation, {
        contentId: resourceId,
        // 分组用资源真实 patch_id (与 apply 的 recalcPatchType 对齐, 防 input 篡改失准)
        patchId: resource.patch_id,
        userId: resource.user_id,
        name: newResource.name
      })
    }

    const resourceResponse: PatchResource = {
      id: newResource.id,
      name: newResource.name,
      section: newResource.section,
      uniqueId: newResource.patch.unique_id,
      type: newResource.type,
      language: newResource.language,
      note: newResource.note,
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
      status,
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

    // 改之前的状态取行锁下读到的 previous, 不取事务外快照
    recordKunChanges(ctx, [
      { kind: 'patch', patchId, uniqueId: newResource.patch.unique_id },
      {
        kind: 'resource',
        id: resourceId,
        patchId,
        ownerId: resource.user_id,
        before: {
          status: previous.status as ResourceStatus,
          section: previous.section
        },
        after: {
          status: status as ResourceStatus,
          section: newResource.section
        }
      }
    ])
    return resourceResponse
  }
  const updatedResource = await kunTx('resource.update', updateInTx, {
    // 没有提交时冲突分支的事务内清理入队也随之撤销: 已重绑对象在此兜底清理
    onRollback: () => abandonBoundResourceObjects(boundObjects())
  })
  if (typeof updatedResource === 'string') {
    return updatedResource
  }

  queueSearchSync(patchId)
  // 即时消费删除出箱；抢不到锁则由定时任务兜底
  kickS3DeletionDrain()

  return updatedResource
}
