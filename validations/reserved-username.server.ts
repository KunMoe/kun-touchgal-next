import * as z from 'zod'
import {
  registerSchema,
  sendRegisterEmailVerificationCodeSchema
} from '~/validations/auth'
import { usernameSchema } from '~/validations/user'
import { newUsernameError } from '~/server/identity/username'

// 上面这些 schema 被客户端表单复用, 只做长度和格式校验; 保留用户名表只存在于
// 服务端, 所以凡是接收用户名的服务端入口都必须用这里的版本, 由它补上那一层。
// 这三个入口永远是在取新名字, 规则 (保留词、不得为邮箱形态) 见 newUsernameError
const newUsernameIssue =
  <K extends string>(key: K) =>
  (data: Record<K, string>, ctx: z.RefinementCtx) => {
    const message = newUsernameError(data[key])
    if (message) {
      ctx.addIssue({ code: 'custom', path: [key], message })
    }
  }

export const registerServerSchema = registerSchema.superRefine(
  newUsernameIssue('name')
)

export const sendRegisterEmailVerificationCodeServerSchema =
  sendRegisterEmailVerificationCodeSchema.superRefine(newUsernameIssue('name'))

export const usernameServerSchema = usernameSchema.superRefine(
  newUsernameIssue('username')
)

// 管理端改用户信息不在这里加 refine: 那是整表单提交, name 恒定携带, schema 层
// 判词会锁死库里存量的保留名用户。校验落在 app/api/admin/user/update.ts 的改名分支
