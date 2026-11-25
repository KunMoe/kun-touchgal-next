import {
  isReservedUsername,
  reservedUsernameMessage
} from '~/constants/reserved-usernames.server'
import { isEmailShaped } from '~/validations/identifier'

export const emailShapedUsernameMessage = '用户名不能是邮箱格式, 请更换'

// 取新名字时的规则 (注册、注册发码、自助改名、管理端改名), 返回失败文案。
// 只用在确实在取新名字的分支: 管理端只在名字与原名不同时调 (trim 之后与原名相同不算改名),
// 挂在 schema 上会把库里存量的保留名、邮箱形态名的账号锁死。
// 不得为邮箱形态: 登录框据此分辨输入的是邮箱还是用户名 (validations/identifier.ts),
// 邮箱形态的输入只查 email 列, 这样的名字没法拿来登录
export const newUsernameError = (name: string): string | undefined => {
  if (isReservedUsername(name)) {
    return reservedUsernameMessage
  }
  if (isEmailShaped(name)) {
    return emailShapedUsernameMessage
  }
  return undefined
}
