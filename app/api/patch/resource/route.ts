import * as z from 'zod'
import { kunId } from '~/validations/primitives'
import { NextResponse } from 'next/server'
import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  patchResourceCreateSchema,
  patchResourceUpdateSchema
} from '~/validations/patch'
import { getPatchResource } from './get'
import { createPatchResource } from './create'
import { updatePatchResource } from './update'
import { deleteResource } from './delete'
import { prisma } from '~/prisma/index'
import { acquireKvLock, releaseKvLock } from '~/lib/redis'
import { canPublishResource } from '~/constants/permission'
import { POINT_GATE_MESSAGE } from '~/constants/points'
import { RESOURCE_STATUS } from '~/constants/contentStatus'

const patchIdSchema = z.object({
  patchId: kunId('游戏 ID')
})

const resourceIdSchema = z.object({
  resourceId: kunId('资源 ID')
})

export const GET = kunRoute.get({
  auth: 'optional',
  input: patchIdSchema,
  handler: ({ input, actor }) => getPatchResource(input, actor)
})

export const POST = kunRoute.post({
  auth: 'user',
  input: patchResourceCreateSchema,
  handler: async ({ input, actor: payload }) => {
    const user = await prisma.user.findUnique({ where: { id: payload.uid } })
    if (!user) {
      return NextResponse.json('未找到该用户')
    }
    // 与上传初始化 (upload/init) 是同一条门槛; 豁免按会话里的角色判, 萌萌点取库里的
    if (
      !canPublishResource({
        uid: payload.uid,
        role: payload.role,
        moemoepoint: user.moemoepoint
      })
    ) {
      return NextResponse.json(POINT_GATE_MESSAGE.publishResource)
    }

    const resource = await prisma.patch_resource.findFirst({
      where: {
        user_id: payload.uid,
        status: RESOURCE_STATUS.awaitingApproval
      }
    })
    if (resource) {
      return NextResponse.json(
        '您有至少一个 Galgame 资源在待审核阶段, 请等待审核结束后再发布资源'
      )
    }

    const lockKey = `lock:patch:resource:create:${payload.uid}`
    let lockToken: string | null = null

    try {
      lockToken = await acquireKvLock(lockKey, 300)
    } catch (error) {
      process.stderr.write(
        `Failed to acquire patch resource lock: ${String(error)}\n`
      )
      return NextResponse.json('资源提交服务暂时不可用, 请稍后重试')
    }

    if (!lockToken) {
      return NextResponse.json('资源正在提交中, 请勿重复点击')
    }

    try {
      const response = await createPatchResource(input, payload)
      return NextResponse.json(response)
    } finally {
      try {
        await releaseKvLock(lockKey, lockToken)
      } catch (error) {
        process.stderr.write(
          `Failed to release patch resource lock: ${String(error)}\n`
        )
      }
    }
  }
})

export const PUT = kunRoute.put({
  auth: 'user',
  input: patchResourceUpdateSchema,
  handler: ({ input, actor }) => updatePatchResource(input, actor, 'front')
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  input: resourceIdSchema,
  handler: ({ input, actor }) => deleteResource(input, actor)
})
