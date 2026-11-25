import { KUN_ROLE, toKunRole } from './role'
import { meetsPointGate } from './points'
import type { KunRole, KunSubject } from './role'

// 能力 → 最低角色。每条权限规则只在这里有一份: 服务端执法、客户端的显隐与置灰都调
// 下面的函数, 调整阈值只改这张表里的一行。posts/notice/role.mdx 的总览表由
// constants/__tests__/permission-matrix.test.ts 逐格对照, 两边必须一起改。
// 表里不放文案: can() 只回答是否, 拒绝文案留在各调用点
export const KUN_CAPABILITY = {
  'admin.access': KUN_ROLE.SUPER_ADMIN,
  'role.assign': KUN_ROLE.SUPER_ADMIN,
  'galgame.create': KUN_ROLE.SUPER_ADMIN,
  'galgame.delete': KUN_ROLE.SUPER_ADMIN,
  'galgame.rewrite': KUN_ROLE.ADMIN,
  'banner.edit': KUN_ROLE.ADMIN,
  'tag.manage': KUN_ROLE.ADMIN,
  'company.manage': KUN_ROLE.ADMIN,
  // 编辑 / 删除他人的评论、评价、资源
  'content.moderateAny': KUN_ROLE.ADMIN,
  // 看得到他人待审核的内容
  'content.viewPending': KUN_ROLE.ADMIN,
  'resource.skipFirstApproval': KUN_ROLE.ADMIN,
  // 发布的资源归入「官方」一栏
  'resource.officialBadge': KUN_ROLE.ADMIN,
  'storage.s3': KUN_ROLE.CREATOR,
  'storage.s3InGalgame': KUN_ROLE.SUPER_ADMIN,
  'storage.touchgal': KUN_ROLE.SUPER_ADMIN,
  'upload.skipCaptcha': KUN_ROLE.ADMIN,
  'upload.skipPointsGate': KUN_ROLE.ADMIN,
  'message.skipPointsGate': KUN_ROLE.ADMIN,
  // 不受按账号的频率预算与审核在途上限约束 (server/abuse、送审第一段): 管理员的入口本身是
  // 特权入口。整站共用的上游配额不看这一项
  'abuse.exempt': KUN_ROLE.ADMIN,
  // 与审核后台的门槛一致: 豁免送审的人必须自己能复核
  'moderation.skip': KUN_ROLE.SUPER_ADMIN
} as const satisfies Record<string, KunRole>

export type KunCapability = keyof typeof KUN_CAPABILITY

// 游客 (没有 subject, 或 uid 为 0 的客户端初始态) 没有任何能力。subject 不一定来自会话
// (库里的行、客户端 store、DTO 都会拿来判), 域外的角色值在这里同样按普通用户算
export const can = (
  subject: KunSubject | null | undefined,
  capability: KunCapability
): boolean =>
  !!subject &&
  subject.uid > 0 &&
  toKunRole(subject.role) >= KUN_CAPABILITY[capability]

// 发布资源的萌萌点门槛与它的角色豁免只有这一份: 上传初始化、创建路由与上传组件都调它。
// 角色取库里的还是会话里的由调用点决定
export const canPublishResource = (
  subject: (KunSubject & { readonly moemoepoint: number }) | null | undefined
): boolean =>
  can(subject, 'upload.skipPointsGate') ||
  (!!subject && subject.uid > 0 && meetsPointGate('publishResource', subject))

// 创作者是身份不是能力: 已经是创作者或以上的不需要再申请
export const isCreatorRole = (role: number): boolean =>
  toKunRole(role) >= KUN_ROLE.CREATOR

export const canApplyCreator = (
  subject: KunSubject | null | undefined
): boolean => !!subject && subject.uid > 0 && !isCreatorRole(subject.role)

// 按权限从高到低排: 默认存储取允许的第一个。取值与 constants/resource.ts 的
// SUPPORTED_RESOURCE_LINK 一致 (测试对照)
export const KUN_LINK_STORAGES = ['touchgal', 's3', 'user'] as const

export type KunLinkStorage = (typeof KUN_LINK_STORAGES)[number]

const isLinkStorageAllowed = (
  subject: KunSubject | null | undefined,
  section: string,
  storage: string
): boolean => {
  switch (storage) {
    case 'user':
      return true
    case 's3':
      // 补丁分区之外 (Galgame 本体) 的对象存储另有更高的门槛
      return can(
        subject,
        section === 'patch' ? 'storage.s3' : 'storage.s3InGalgame'
      )
    case 'touchgal':
      return can(subject, 'storage.touchgal')
    default:
      return false
  }
}

// 存储 × 分区 × 角色
export const allowedLinkStorages = (
  subject: KunSubject | null | undefined,
  section: string
): readonly KunLinkStorage[] =>
  KUN_LINK_STORAGES.filter((storage) =>
    isLinkStorageAllowed(subject, section, storage)
  )

export const defaultLinkStorage = (
  subject: KunSubject | null | undefined,
  section: string
): KunLinkStorage => allowedLinkStorages(subject, section)[0] ?? 'user'

// 返回第一个不被允许的存储。哪些链接要判 (编辑时原样带回的存量不判) 由执法点决定,
// 见 app/api/patch/resource/storageGate.ts
export const findDisallowedLinkStorage = (
  subject: KunSubject | null | undefined,
  section: string,
  links: readonly { storage: string }[]
): string | null =>
  links.find((link) => !isLinkStorageAllowed(subject, section, link.storage))
    ?.storage ?? null

// 能被授予的角色; 超级管理员不在其中
export const KUN_GRANTABLE_ROLES = [
  KUN_ROLE.USER,
  KUN_ROLE.CREATOR,
  KUN_ROLE.ADMIN
] as const

// 按 delta 判定: 角色没有变化恒放行 (下拉里列着当前值), 否则操作者要有授予角色的能力,
// 且目标角色可被授予
export const canAssignRole = (
  subject: KunSubject | null | undefined,
  change: { current: number; next: number }
): boolean =>
  change.next === change.current ||
  (can(subject, 'role.assign') &&
    KUN_GRANTABLE_ROLES.some((role) => role === change.next))

// 后台改不了超级管理员账号的邮箱、密码、角色与状态, 也关不了它的两步验证 (服务端拒绝, 弹窗里
// 置灰): 邮箱、密码与 2FA 由本人经带二次验证的自助入口改, 后台不能成为绕过它的通道; 后台的
// 操作者自己就是超级管理员, 这一条同时挡住在后台封禁、降权自己
export const isSuperAdminRole = (role: number): boolean =>
  toKunRole(role) >= KUN_ROLE.SUPER_ADMIN
