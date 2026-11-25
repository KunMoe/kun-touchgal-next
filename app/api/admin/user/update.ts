import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { adminPatchUserSchema } from '~/validations/admin'
import { newUsernameError } from '~/server/identity/username'
import { isEmailTaken, isUsernameTaken } from '~/server/identity/lookup'
import {
  applyKunCredentialChange,
  finishKunSecurityEvent
} from '~/server/auth/securityEvents'
import { hashPassword } from '~/app/api/utils/algorithm'
import { can, canAssignRole, isSuperAdminRole } from '~/constants/permission'
import { adjustPoints } from '~/server/points/account'
import type { AdminUserPatchResult } from '~/types/api/admin'

// 合并契约 (validations/admin.ts): 没带的键不写, 带了的键即这次的修改意图
export const updateUser = async (
  input: z.infer<typeof adminPatchUserSchema>,
  adminUid: number
): Promise<AdminUserPatchResult | string> => {
  // 凭据与权限列 (email / role / status / password) 与普通资料列一起经
  // applyKunCredentialChange 写入; 萌萌点只经 server/points 按差值写
  const {
    uid,
    password,
    email,
    role,
    status,
    moemoepointDelta,
    resetDailyImageCount,
    ...rest
  } = input

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
  if (
    isSuperAdminRole(user.role) &&
    [email, password, role, status].some((value) => value !== undefined)
  ) {
    return '不能在后台修改超级管理员的邮箱、密码、角色或状态'
  }
  // 角色按 delta 判定: 操作者要有授予角色的能力, 目标角色也要可被授予 (超级管理员不在其中)
  const operator = { uid: adminUid, role: admin.role }
  if (
    role !== undefined &&
    !canAssignRole(operator, { current: user.role, next: role })
  ) {
    return can(operator, 'role.assign')
      ? '不能将用户设置为该角色'
      : '设置用户为管理员仅限超级管理员可用'
  }
  // 新名字的规则 (保留词、不得为邮箱形态) 只拦「改名」这一步, 不挂在 schema 上: 名字只差
  // 前后空白时 trim 之后与原名相同, 不算取新名字, 库里存量的保留名用户 (含 uid 1 与冒名的
  // admin) 不会被拦。查重与注册同一个口径 (大小写不敏感), 并排除目标用户自己: 只改大小写不算占用
  if (rest.name !== undefined && rest.name !== user.name) {
    const nameError = newUsernameError(rest.name)
    if (nameError) {
      return nameError
    }
    if (await isUsernameTaken(rest.name, { exceptUid: uid })) {
      return '该用户名已被其他用户使用'
    }
  }
  // 必须先判 undefined: 没带邮箱时不查重
  const emailChanged = email !== undefined && email !== user.email
  if (emailChanged && (await isEmailTaken(email, { exceptUid: uid }))) {
    return '该邮箱已被其他用户使用'
  }

  const hashedPassword = password ? await hashPassword(password) : undefined
  // 请求里只有这次改了的键, 日志的「更改内容」就是差异
  const logInput = {
    ...input,
    ...(password ? { password: '[REDACTED]' } : {})
  }
  const data = {
    email,
    role,
    status,
    ...rest,
    ...(resetDailyImageCount ? { daily_image_count: 0 } : {}),
    ...(hashedPassword ? { password: hashedPassword } : {})
  }

  // 改了密码或邮箱的是账号恢复, 要刷新安全戳; 其余资料与权限的改动照旧只删会话
  const event =
    hashedPassword || emailChanged
      ? 'admin-credentials-changed'
      : 'admin-edited'
  const result = await kunTx(
    'admin.user.update',
    async ({ tx: prisma }) => {
      // 只调萌萌点时没有别的列要写: 用户若已被删, 由 adjustPoints 的 update 报 P2025
      if (Object.values(data).some((value) => value !== undefined)) {
        const { count } = await applyKunCredentialChange(prisma, {
          uid,
          event,
          data
        })
        // 与此前的 update 一样: 用户在查询之后被删了就整笔回滚 (不写审计日志)
        if (!count) {
          throw new Error(`用户 ${uid} 已不存在`)
        }
      }
      if (moemoepointDelta) {
        await adjustPoints(prisma, uid, moemoepointDelta)
      }

      await prisma.admin_log.create({
        data: {
          type: 'update',
          user_id: adminUid,
          content: `管理员 ${admin.name} 更改了一个用户的信息\n\n更改内容:\n${JSON.stringify(logInput)}\n\n原用户信息:\n${JSON.stringify(user)}`
        }
      })

      const saved = await prisma.user.findUniqueOrThrow({
        where: { id: uid },
        select: {
          id: true,
          name: true,
          email: true,
          bio: true,
          role: true,
          status: true,
          daily_image_count: true,
          moemoepoint: true
        }
      })
      return {
        id: saved.id,
        name: saved.name,
        email: saved.email,
        bio: saved.bio,
        role: saved.role,
        status: saved.status,
        dailyImageCount: saved.daily_image_count,
        moemoepoint: saved.moemoepoint
      }
    },
    {
      // 上面的查重与这里的写入之间有窗口: 同时被别人取走的名字或邮箱 (含只差大小写) 撞唯一索引
      violations: { P2002: '该用户名或邮箱已被其他用户使用' }
    }
  )
  if (typeof result === 'string') {
    return result
  }

  // 改权 (降权 / 封禁) 必须删光会话 (策略表 admin-edited: redis all): 删掉 access token 使
  // 旧凭证校验先行失败, 是「旧鉴权缓存不被采信」的根闸门。不能只轮转缓存版本键, 那一步的
  // 失败会被吞掉, 存活的旧 token 将命中旧权限缓存。不按这次改了哪些列收窄, 每次保存都删
  await finishKunSecurityEvent(uid, event)
  return result
}
