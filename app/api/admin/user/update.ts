import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { adminUpdateUserSchema } from '~/validations/admin'
import { newUsernameError } from '~/server/identity/username'
import { isEmailTaken, isUsernameTaken } from '~/server/identity/lookup'
import {
  applyKunCredentialChange,
  finishKunSecurityEvent
} from '~/server/auth/securityEvents'
import { hashPassword } from '~/app/api/utils/algorithm'
import { can, canAssignRole } from '~/constants/permission'
import { adjustPoints } from '~/server/points/account'

export const updateUser = async (
  input: z.infer<typeof adminUpdateUserSchema>,
  adminUid: number
) => {
  // 凭据与权限列 (email / role / status / password) 单独解构, 经 applyKunCredentialChange 写入;
  // 萌萌点只经 server/points 按差值写; rest 里只剩普通资料列
  const {
    uid,
    dailyImageCount,
    password,
    email,
    role,
    status,
    moemoepointDelta,
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
  // 角色按 delta 判定: 没改角色就放行; 改了, 操作者要有授予角色的能力, 目标角色也要
  // 可被授予 (超级管理员不在其中)
  const operator = { uid: adminUid, role: admin.role }
  if (!canAssignRole(operator, { current: user.role, next: role })) {
    return can(operator, 'role.assign')
      ? '不能将用户设置为该角色'
      : '设置用户为管理员仅限超级管理员可用'
  }
  // 新名字的规则 (保留词、不得为邮箱形态) 只拦「改名」这一步: 表单整体提交, name 恒定
  // 携带, 若在 schema 层判会把库里存量的保留名用户 (含 uid 1 与冒名的 admin) 锁死, 连封禁
  // 都做不了。查重与注册同一个口径 (大小写不敏感), 并排除目标用户自己: 只改大小写不算占用
  if (rest.name !== user.name) {
    const nameError = newUsernameError(rest.name)
    if (nameError) {
      return nameError
    }
    if (await isUsernameTaken(rest.name, { exceptUid: uid })) {
      return '该用户名已被其他用户使用'
    }
  }
  if (email !== user.email) {
    if (await isEmailTaken(email, { exceptUid: uid })) {
      return '该邮箱已被其他用户使用'
    }
  }

  const hashedPassword = password ? await hashPassword(password) : undefined
  const logInput = {
    ...input,
    ...(password ? { password: '[REDACTED]' } : {})
  }

  // 改了密码或邮箱的是账号恢复, 要刷新安全戳; 其余资料与权限的改动照旧只删会话
  const event =
    hashedPassword || email !== user.email
      ? 'admin-credentials-changed'
      : 'admin-edited'
  const result = await kunTx(
    'admin.user.update',
    async ({ tx: prisma }) => {
      const { count } = await applyKunCredentialChange(prisma, {
        uid,
        event,
        data: {
          daily_image_count: dailyImageCount,
          email,
          role,
          status,
          ...rest,
          ...(hashedPassword ? { password: hashedPassword } : {})
        }
      })
      // 与此前的 update 一样: 用户在查询之后被删了就整笔回滚 (不写审计日志)
      if (!count) {
        throw new Error(`用户 ${uid} 已不存在`)
      }
      // 列表显示写后的余额: 没调整时就是本次请求开头读到的值
      const moemoepoint = moemoepointDelta
        ? await adjustPoints(prisma, uid, moemoepointDelta)
        : user.moemoepoint

      await prisma.admin_log.create({
        data: {
          type: 'update',
          user_id: adminUid,
          content: `管理员 ${admin.name} 更改了一个用户的信息\n\n更改内容:\n${JSON.stringify(logInput)}\n\n原用户信息:\n${JSON.stringify(user)}`
        }
      })
      return { moemoepoint }
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
  // 失败会被吞掉, 存活的旧 token 将命中旧权限缓存
  await finishKunSecurityEvent(uid, event)
  return result
}
