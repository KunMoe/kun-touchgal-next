import * as z from 'zod'

// 登录标识符的空间 (T18)。一个账号有两个登录标识符 (name、email), 登录框只有一个输入,
// 「这一串是邮箱还是用户名」只在这里判定。以前两者互不相交只是注册正则的副作用
// (kunUsernameRegex 不收 `.`), 自助改名与管理端改名刻意只校验长度, 可以改出邮箱形态的
// 名字, 登录用 OR 同时查两列且不排序, 在邮箱持有者与这个名字之间二选一 (P07-02)。
//
// 本文件会进客户端 (validations/auth.ts 的 loginSchema 由这里派生), 只放纯函数;
// 查库在 server/identity/lookup.ts, 新名字的规则 (保留词 + 不得为邮箱形态) 在
// server/identity/username.ts (保留词表只在服务端)。

const emailShape = z.string().trim().email()

// 「邮箱形态」的唯一定义: 与注册、改邮箱的 schema 同一个 zod 邮箱判定
export const isEmailShaped = (value: string) =>
  emailShape.safeParse(value).success

export type LoginIdentifier =
  { kind: 'email'; raw: string } | { kind: 'name'; raw: string }

// raw 只 trim、不小写: 规范化只发生在数据库查询里 (大小写不敏感的 ILIKE)。
// 邮箱验证码的 Redis 键是裸邮箱, 这里先小写会让键错位
export const classifyLoginIdentifier = (input: string): LoginIdentifier => {
  const raw = input.trim()
  return isEmailShaped(raw) ? { kind: 'email', raw } : { kind: 'name', raw }
}

// 登录框收「邮箱」或「1~17 个字符的用户名」。用户名一侧与改名规则 (validations/user.ts
// 的 usernameSchema、admin 的 adminUpdateUserSchema) 一致, 不套注册正则: 改名放行的
// 「Mr.Pizza」「Nihil Contingens」以前只能用邮箱登录。长度按码点计, 与 zod 的 .max、
// 库里 VarChar(17) 的字符数同一个单位。NUL 单独拒绝: PostgreSQL 的文本存不了它, 库里不可能
// 有这样的名字, 放过去查询会以 22021 报错、回 500 (注册正则以前在这里就拒掉了)
const LOGIN_IDENTIFIER_MESSAGE =
  '请输入合法的邮箱格式, 用户名则应为 1~17 位任意字符'

export const loginIdentifierSchema = z
  .string({ message: LOGIN_IDENTIFIER_MESSAGE })
  .trim()
  .refine(
    (value) => {
      if (value.includes('\u0000')) {
        return false
      }
      if (isEmailShaped(value)) {
        return true
      }
      const length = [...value].length
      return length >= 1 && length <= 17
    },
    { message: LOGIN_IDENTIFIER_MESSAGE }
  )
