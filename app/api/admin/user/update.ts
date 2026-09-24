import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminUpdateUserSchema } from '~/validations/admin'
import {
  isReservedUsername,
  reservedUsernameMessage
} from '~/constants/reserved-usernames.server'
import { deleteKunToken } from '~/app/api/utils/jwt'
import { hashPassword } from '~/app/api/utils/algorithm'

export const updateUser = async (
  input: z.infer<typeof adminUpdateUserSchema>,
  adminUid: number
) => {
  const { uid, dailyImageCount, password, ...rest } = input

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: {
      id: true,
      daily_image_count: true,
      moemoepoint: true,
      name: true,
      email: true,
      bio: true,
      role: true,
      status: true
    }
  })
  if (!user) {
    return '未找到该用户'
  }

  const admin = await prisma.user.findUnique({
    where: { id: adminUid },
    select: { role: true, name: true }
  })
  if (!admin) {
    return '未找到该管理员'
  }
  if (rest.role >= 3 && admin.role < 4) {
    return '设置用户为管理员仅限超级管理员可用'
  }
  // 保留词只拦「改名」这一步: 表单整体提交, name 恒定携带, 若在 schema 层判
  // 会把库里存量的保留名用户 (含 uid 1 与冒名的 admin) 锁死, 连封禁都做不了
  if (rest.name !== user.name) {
    if (isReservedUsername(rest.name)) {
      return reservedUsernameMessage
    }
    const existingUserByName = await prisma.user.findUnique({
      where: { name: rest.name },
      select: { id: true }
    })
    if (existingUserByName) {
      return '该用户名已被其他用户使用'
    }
  }
  if (rest.email !== user.email) {
    const existingUserByEmail = await prisma.user.findUnique({
      where: { email: rest.email },
      select: { id: true }
    })
    if (existingUserByEmail) {
      return '该邮箱已被其他用户使用'
    }
  }

  const hashedPassword = password ? await hashPassword(password) : undefined
  const logInput = {
    ...input,
    ...(password ? { password: '[REDACTED]' } : {})
  }

  const result = await prisma.$transaction(async (prisma) => {
    await prisma.user.update({
      where: { id: uid },
      data: {
        daily_image_count: dailyImageCount,
        ...rest,
        ...(hashedPassword ? { password: hashedPassword } : {})
      }
    })

    await prisma.admin_log.create({
      data: {
        type: 'update',
        user_id: adminUid,
        content: `管理员 ${admin.name} 更改了一个用户的信息\n\n更改内容:\n${JSON.stringify(logInput)}\n\n原用户信息:\n${JSON.stringify(user)}`
      }
    })

    return {}
  })

  // 改权(降权/封禁)必须用 deleteKunToken: 它硬删 access token 使旧凭证校验先行
  // 失败, 是「旧鉴权缓存不被采信」的根闸门。不可替换为只轮转缓存 version 的
  // invalidateUserSession —— 后者轮转失败会被吞掉, 存活旧 token 将命中旧权限缓存
  await deleteKunToken(uid)
  return result
}
