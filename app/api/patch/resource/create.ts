import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { patchResourceCreateSchema } from '~/validations/patch'
import { createMessage } from '~/app/api/utils/message'
import {
  abandonBoundResourceObjects,
  bindUploadedResource,
  recalcPatchType
} from './_helper'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { enqueueSearchOutbox, queueSearchSync } from '~/server/search/sync'
import {
  MODERATION_SKIP,
  enqueueTextModeration,
  planTextModeration
} from '~/server/moderation/submit'
import {
  resourceSubject,
  submittedLinkSubject
} from '~/server/moderation/subject'
import { renderKunMarkdownForWrite } from '~/app/api/utils/render/renderKunMarkdown'
import { can } from '~/constants/permission'
import { linkStorageGateError } from './storageGate'
import { kunTx } from '~/server/db/tx'
import { creditPoints } from '~/server/points/account'
import { formatResourceSize } from '~/utils/resourceSize'
import { recordKunChanges } from '~/server/cache/publish'
import type { PatchResource } from '~/types/api/patch'
import type { ResourceStatus } from '~/constants/contentStatus'
import type { KunActor } from '~/constants/role'
import type { KunTxContext } from '~/server/db/tx'
import { RESOURCE_STATUS } from '~/constants/contentStatus'

export const createPatchResource = async (
  input: z.infer<typeof patchResourceCreateSchema>,
  actor: KunActor
) => {
  const { uid } = actor
  const {
    patchId: inputPatchId,
    type,
    language,
    platform,
    emulatorType,
    modelName,
    links,
    ...resourceData
  } = input
  // 联动字段随所选平台/类型归一: 未含对应平台/类型时不落库残值
  const emulator_type = platform.includes('emulator') ? emulatorType : []
  const model_name = type.includes('ai') ? modelName : ''

  const storageError = linkStorageGateError(actor, {
    section: input.section,
    links
  })
  if (storageError) {
    return storageError
  }

  const [currentPatch, resourceCount] = await Promise.all([
    prisma.patch.findUnique({
      where: { id: inputPatchId },
      select: {
        id: true,
        unique_id: true,
        name: true
      }
    }),
    prisma.patch_resource.count({
      where: { user_id: uid }
    })
  ])
  if (!currentPatch) {
    return '未找到该资源对应的 Galgame 信息, 请确认 Galgame 存在'
  }
  const patchId = currentPatch.id
  const needApproval =
    resourceCount === 0 && !can(actor, 'resource.skipFirstApproval')

  // 渲染不出来的备注在落库前拒绝 (只检查: 备注的 HTML 不落库, 详情页读时渲染)
  const renderable = await renderKunMarkdownForWrite('note', input.note)
  if (typeof renderable === 'string') {
    return renderable
  }

  // 首个资源走既有人工审批流 (status=2), 不重复送 AI 审核;
  // 送审字段由 resourceSubject 的策略表决定, 全空的资源无文本可审, 直接放行
  const moderation = needApproval
    ? MODERATION_SKIP
    : await planTextModeration(
        resourceSubject({
          name: input.name,
          note: input.note,
          modelName: model_name,
          links: links.map((link) => submittedLinkSubject(link))
        }),
        { actor }
      )
  if (typeof moderation === 'string') {
    return moderation
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
  // 早退不清理即泄漏此前迭代已绑定的对象 (staging/token 已删, 无法复用)
  const boundObjects: Array<{ content: string; s3Key: string }> = []
  // bind 抛错 (Redis/配额 DB 故障、copy 超时 rethrow) 同样泄漏历史条目: 抛错的
  // 迭代要么未创建 finalKey 要么已在 _helper 内自清, 循环级 catch 只清历史无双删
  try {
    for (const [index, link] of links.entries()) {
      let content: string
      let size: string
      let s3Key = ''
      if (link.storage === 's3') {
        // 新建的资源没有可沿用的行: 对象存储链接必须带着一次上传 (只带 id 的过得了校验)
        if (!link.uploadToken) {
          await abandonBoundResourceObjects(boundObjects, patchId)
          return '请先上传资源文件'
        }
        const result = await bindUploadedResource(
          patchId,
          link.uploadToken,
          uid
        )
        if (typeof result === 'string') {
          await abandonBoundResourceObjects(boundObjects, patchId)
          return result
        }
        // 地址、对象 key 与大小都取绑定的结果, 不取请求里的值
        content = result.downloadLink
        size = formatResourceSize(result.size)
        s3Key = result.s3Key
        boundObjects.push({ content, s3Key })
      } else {
        content = link.content
        size = link.size
      }

      preparedLinks.push({
        storage: link.storage,
        size,
        code: link.code,
        password: link.password,
        // hash 列只存历史对象的校验码, 新行一律为空
        hash: '',
        s3_key: s3Key,
        content,
        sort_order: index,
        download: 0
      })
    }
  } catch (error) {
    await abandonBoundResourceObjects(boundObjects, patchId)
    throw error
  }

  // 回调单独成句, 不写进 kunTx 的参数里: 带着选项内联的话 prettier 会把整段事务体重缩进
  const createInTx = async (ctx: KunTxContext) => {
    const { tx: prisma } = ctx
    const newResource = await prisma.patch_resource.create({
      data: {
        patch_id: patchId,
        user_id: uid,
        type,
        language,
        platform,
        emulator_type,
        model_name,
        status: needApproval
          ? RESOURCE_STATUS.awaitingApproval
          : moderation.intercept
            ? RESOURCE_STATUS.pending
            : RESOURCE_STATUS.public,
        ...resourceData,
        links: {
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
        links: {
          orderBy: { sort_order: 'asc' }
        }
      }
    })

    await creditPoints(prisma, uid, 'resource_publish')

    if (moderation.queue) {
      await enqueueTextModeration(prisma, moderation, {
        contentId: newResource.id,
        patchId,
        userId: uid,
        name: newResource.name
      })
    }

    await prisma.patch.update({
      where: { id: patchId },
      data: { resource_update_time: new Date() }
    })
    await recalcPatchType(patchId, prisma)
    // 事务性入队：与补丁变更原子提交，关闭崩溃丢失窗口
    await enqueueSearchOutbox(prisma, patchId)

    const resource: PatchResource = {
      id: newResource.id,
      name: newResource.name,
      section: newResource.section,
      uniqueId: currentPatch.unique_id,
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

    recordKunChanges(ctx, [
      { kind: 'patch', patchId, uniqueId: currentPatch.unique_id },
      {
        kind: 'resource',
        id: newResource.id,
        patchId,
        ownerId: uid,
        before: null,
        after: {
          status: newResource.status as ResourceStatus,
          section: newResource.section
        }
      }
    ])
    return resource
  }
  const resource = await kunTx('resource.create', createInTx, {
    // 没有提交则行未落库: 已绑定对象无 DB 引用, 兜底清理
    onRollback: () => abandonBoundResourceObjects(boundObjects, patchId)
  })
  if (typeof resource === 'string') {
    return resource
  }

  queueSearchSync(patchId)
  await invalidateUserSession(uid)

  if (needApproval) {
    await createMessage({
      type: 'system',
      content: `您的首个资源「${currentPatch.name}」已提交审核，通过后将自动公开显示。`,
      recipient_id: uid,
      link: `/${currentPatch.unique_id}?tab=resources&resourceSection=${resource.section}&resourceId=${resource.id}`
    })
    // 通知在事务外自动提交, 紧随其后失效上传者未读缓存即为提交后失效 (L-01)
    await invalidateUnread(uid).catch(() => undefined)
  }

  return resource
}
