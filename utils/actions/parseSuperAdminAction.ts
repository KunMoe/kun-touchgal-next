import { safeParseSchema } from './safeParseSchema'
import { verifyHeaderCookie } from './verifyHeaderCookie'
import { can } from '~/constants/permission'
import type { z } from 'zod'
import type { ZodSchema } from 'zod'

export const verifySuperAdmin = async (): Promise<string | null> => {
  const payload = await verifyHeaderCookie()
  if (!payload) {
    return '用户登录失效'
  }
  if (!can(payload, 'admin.access')) {
    return '本页面仅超级管理员可访问'
  }
  return null
}

export const parseSuperAdminAction = async <T extends ZodSchema>(
  schema: T,
  params: Record<string, unknown>
): Promise<z.infer<T> | string> => {
  const input = safeParseSchema(schema, params)
  if (typeof input === 'string') {
    return input
  }
  const error = await verifySuperAdmin()
  if (error) {
    return error
  }
  return input
}
