import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import {
  kunParseDeleteQuery,
  kunParseGetQuery,
  kunParsePostBody,
  kunParsePutBody
} from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
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

const patchIdSchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999)
})

const resourceIdSchema = z.object({
  resourceId: z.coerce
    .number({ message: '资源 ID 必须为数字' })
    .min(1)
    .max(9999999)
})

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, patchIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)

  const response = await getPatchResource(input, payload)
  return NextResponse.json(response)
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, patchResourceCreateSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (
    payload.role < 4 &&
    input.links.some((link) => link.storage === 'touchgal')
  ) {
    return NextResponse.json('仅超级管理员可使用 TouchGal 资源盘')
  }

  const user = await prisma.user.findUnique({ where: { id: payload.uid } })
  if (!user) {
    return NextResponse.json('未找到该用户')
  }
  if (user.moemoepoint < 20) {
    return NextResponse.json('仅限萌萌点大于 20 的用户才可以发布资源')
  }

  const resource = await prisma.patch_resource.findFirst({
    where: { user_id: payload.uid, status: 2 }
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
    const response = await createPatchResource(input, payload.uid, payload.role)
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

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, patchResourceUpdateSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (
    payload.role < 4 &&
    input.links.some((link) => link.storage === 'touchgal')
  ) {
    return NextResponse.json('仅超级管理员可使用 TouchGal 资源盘')
  }

  const response = await updatePatchResource(input, payload.uid, payload.role)
  return NextResponse.json(response)
}

export const DELETE = async (req: NextRequest) => {
  const input = kunParseDeleteQuery(req, resourceIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await deleteResource(input, payload.uid, payload.role)
  return NextResponse.json(response)
}
