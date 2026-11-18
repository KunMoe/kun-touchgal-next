// 角色的唯一定义。零 import, 前后端同构; 能力与阈值在 constants/permission.ts

export const KUN_ROLE = {
  USER: 1,
  CREATOR: 2,
  ADMIN: 3,
  SUPER_ADMIN: 4
} as const

export type KunRole = (typeof KUN_ROLE)[keyof typeof KUN_ROLE]

export const KUN_ROLE_LABEL: Record<KunRole, string> = {
  1: '用户',
  2: '创作者',
  3: '管理员',
  4: '超级管理员'
}

// 域外的值 (库里的脏数据、旧缓存) 回落为普通用户, 即失败时取最小权限
export const toKunRole = (role: number): KunRole =>
  role === KUN_ROLE.CREATOR ||
  role === KUN_ROLE.ADMIN ||
  role === KUN_ROLE.SUPER_ADMIN
    ? role
    : KUN_ROLE.USER

// 能被判定权限的最小形状: userStore 的 user、会话 payload、KunViewer 都满足
export interface KunSubject {
  readonly uid: number
  readonly role: number
}

declare const kunActorBrand: unique symbol

// 已经过会话校验的操作者。品牌只存在于编译期, 唯一的构造点是 app/api/utils/jwt.ts 的
// verifyAndLoadUser: 手写的 { uid, role: 3 } 赋不进来, 所以签名收 KunActor 的服务拿不到
// 调用点伪造的角色。展开后覆写 role 与 `as KunActor` 类型上拦不住, 由 lint 封住
export type KunActor = KunSubject & {
  readonly role: KunRole
  readonly name: string
  readonly [kunActorBrand]: true
}
