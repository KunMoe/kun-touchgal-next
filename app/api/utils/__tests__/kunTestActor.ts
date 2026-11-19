import type { KunActor, KunRole } from '~/constants/role'

// 测试里构造 KunActor 的唯一入口。生产代码的构造点只有 server/auth/session.ts 的
// resolveKunSiteSession; 测试直接调服务时没有会话可走, 所以单独留这一个断言
export const kunTestActor = ({
  uid,
  role,
  name = `user-${uid}`
}: {
  uid: number
  role: KunRole
  name?: string
}): KunActor => ({ uid, role, name }) as KunActor
