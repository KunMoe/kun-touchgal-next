import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { updatePatchResource as updatePatchResourceByRole } from '~/app/api/patch/resource/update'
import { sanitizeResourceLinksForAuditLog } from '~/app/api/patch/resource/_helper'
import { patchResourceUpdateSchema } from '~/validations/patch'
import { truncateLogContent } from '~/app/api/admin/_log'
import { RESOURCE_STATUS } from '~/constants/contentStatus'

export const updatePatchResource = async (
  input: z.infer<typeof patchResourceUpdateSchema>,
  uid: number,
  role: number
) => {
  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  const { resourceId } = input
  const resource = await prisma.patch_resource.findUnique({
    where: { id: resourceId }
  })
  if (!resource) {
    return '未找到该资源'
  }

  // 以操作者的真实角色编辑: 送审豁免只看角色 (超级管理员豁免), 不由入口伪造。
  // 后台可以编辑任何状态的资源, 包括隐藏的 (编辑后仍是隐藏)
  const updatedResource = await updatePatchResourceByRole(
    input,
    { uid, role },
    { statusIn: Object.values(RESOURCE_STATUS) }
  )
  if (typeof updatedResource === 'string') {
    return updatedResource
  }

  const sanitizedUpdated = {
    ...updatedResource,
    links: sanitizeResourceLinksForAuditLog(updatedResource.links)
  }

  return await prisma.$transaction(async (prisma) => {
    await prisma.admin_log.create({
      data: {
        type: 'update',
        user_id: uid,
        // 新旧 note 各有 10007 上限, 拼接后必须截断; 此日志写在资源更新已提交
        // 之后, 一旦 22001 会用 500 掩盖已生效的更新
        content: truncateLogContent(
          `管理员 ${admin.name} 更新了一个资源信息\n\n原资源信息:\n${JSON.stringify(resource)}\n\n新资源信息:\n${JSON.stringify(sanitizedUpdated)}`
        )
      }
    })

    return updatedResource
  })
}
