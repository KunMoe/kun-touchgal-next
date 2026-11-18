import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  KUN_CAPABILITY,
  KUN_GRANTABLE_ROLES,
  KUN_LINK_STORAGES,
  allowedLinkStorages,
  can,
  canApplyCreator,
  canAssignRole,
  defaultLinkStorage,
  findDisallowedLinkStorage
} from '~/constants/permission'
import { KUN_ROLE, KUN_ROLE_LABEL, toKunRole } from '~/constants/role'
import { SUPPORTED_RESOURCE_LINK } from '~/constants/resource'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import type { KunCapability } from '~/constants/permission'
import type { KunActor, KunSubject } from '~/constants/role'

const ROLES = [1, 2, 3, 4] as const
const subjectOf = (role: number): KunSubject => ({ uid: 7, role })

const loggedIn = (subject: KunSubject) => subject.uid > 0
const has = (capability: KunCapability) => (subject: KunSubject) =>
  can(subject, capability)

// posts/notice/role.mdx「角色权限总览」的行标签 → 判定函数。
// 站点对外公布的权限说明与代码里的能力表在这里逐格对照: 改了其中一边, 另一边不跟着改就会红
const ROW_PREDICATES: Record<string, (subject: KunSubject) => boolean> = {
  '登录、修改个人资料': loggedIn,
  '关注用户、收藏游戏、发送站内消息': loggedIn,
  '发表评论、发布评分、提交反馈': loggedIn,
  '编辑/删除自己的评论、评分、资源': loggedIn,
  发布资源: loggedIn,
  '使用外链/普通用户资源方式发布资源': (subject) =>
    ['galgame', 'patch'].every((section) =>
      allowedLinkStorages(subject, section).includes('user')
    ),
  '上传文件到对象存储 `S3`': has('storage.s3'),
  '使用 `TouchGal` 资源盘': has('storage.touchgal'),
  首个资源免审: has('resource.skipFirstApproval'),
  申请成为创作者: canApplyCreator,
  '创建 Galgame 本体': has('galgame.create'),
  '编辑 Galgame 本体': has('galgame.rewrite'),
  '删除 Galgame 本体': has('galgame.delete'),
  '修改游戏 Banner': has('banner.edit'),
  '创建/编辑/删除标签': has('tag.manage'),
  '创建/编辑会社': has('company.manage'),
  '为游戏增删会社、从 VNDB 拉会社': has('company.manage'),
  '访问 `/admin` 路径下的后台接口与页面': has('admin.access'),
  处理创作者申请: has('admin.access'),
  编辑其他用户的信息: has('admin.access'),
  将其他用户设为管理员: (subject) =>
    canAssignRole(subject, { current: KUN_ROLE.USER, next: KUN_ROLE.ADMIN }),
  删除用户: has('admin.access'),
  '强制关闭其他用户 2FA': has('admin.access'),
  向全站用户群发邮件: has('admin.access')
}

const readOverviewTable = () => {
  const mdx = readFileSync(
    fileURLToPath(new URL('../../posts/notice/role.mdx', import.meta.url)),
    { encoding: 'utf-8' }
  )
  const start = mdx.indexOf('## 角色权限总览')
  const end = mdx.indexOf('\n## ', start + 1)
  return mdx
    .slice(start, end === -1 ? undefined : end)
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
    )
    .filter((cells) => !/^-+$/.test(cells[0]))
}

describe('权限矩阵与 role.mdx 的总览表逐格一致', () => {
  const [header, ...rows] = readOverviewTable()

  it('表头是四个角色, 顺序为 Role 1 → 4', () => {
    expect(header.slice(1)).toEqual(
      ROLES.map((role) => `Role ${role} ${KUN_ROLE_LABEL[role]}`)
    )
  })

  it('表里的每一行都有判定函数, 判定函数没有多余的行', () => {
    expect(rows.map((cells) => cells[0]).sort()).toEqual(
      Object.keys(ROW_PREDICATES).sort()
    )
  })

  it.each(rows.map((cells) => [cells[0], cells.slice(1)] as const))(
    '%s',
    (label, cells) => {
      // 「不需要」只出现在申请创作者一行: 已经是创作者或以上, 入口不开放
      for (const cell of cells) {
        expect(['可以', '不可以', '不需要']).toContain(cell)
      }
      expect(
        ROLES.map((role) => ROW_PREDICATES[label](subjectOf(role)))
      ).toEqual(cells.map((cell) => cell === '可以'))
    }
  )
})

describe('can', () => {
  it('每项能力的阈值都是一个合法角色, 恰好从该角色起放行', () => {
    for (const [capability, min] of Object.entries(KUN_CAPABILITY)) {
      expect(ROLES).toContain(min)
      expect(
        ROLES.filter((role) =>
          can(subjectOf(role), capability as KunCapability)
        )
      ).toEqual(ROLES.filter((role) => role >= min))
    }
  })

  it('游客没有任何能力: 没有 subject, 或 uid 为 0 (客户端初始态、公共视角)', () => {
    for (const capability of Object.keys(KUN_CAPABILITY) as KunCapability[]) {
      expect(can(null, capability)).toBe(false)
      expect(can(undefined, capability)).toBe(false)
      expect(can({ uid: 0, role: 4 }, capability)).toBe(false)
    }
    expect(canApplyCreator(null)).toBe(false)
    expect(canApplyCreator({ uid: 0, role: 1 })).toBe(false)
  })
})

describe('toKunRole', () => {
  it('域内的值原样返回, 域外的值回落为普通用户', () => {
    expect(ROLES.map(toKunRole)).toEqual([1, 2, 3, 4])
    expect([0, -1, 5, 2.5, Number.NaN].map(toKunRole)).toEqual([1, 1, 1, 1, 1])
  })
})

describe('存储 × 分区 × 角色', () => {
  it('存储取值与资源链接校验用的清单一致', () => {
    expect([...KUN_LINK_STORAGES].sort()).toEqual(
      [...SUPPORTED_RESOURCE_LINK].sort()
    )
  })

  it.each([
    [1, 'patch', ['user']],
    [1, 'galgame', ['user']],
    [2, 'patch', ['s3', 'user']],
    [2, 'galgame', ['user']],
    [3, 'patch', ['s3', 'user']],
    [3, 'galgame', ['user']],
    [4, 'patch', ['touchgal', 's3', 'user']],
    [4, 'galgame', ['touchgal', 's3', 'user']]
  ] as const)('role %i 在 %s 分区可用 %j', (role, section, storages) => {
    expect(allowedLinkStorages(subjectOf(role), section)).toEqual(storages)
  })

  it.each([
    [1, 'patch', 'user'],
    [1, 'galgame', 'user'],
    [2, 'patch', 's3'],
    [2, 'galgame', 'user'],
    [3, 'patch', 's3'],
    [3, 'galgame', 'user'],
    [4, 'patch', 'touchgal'],
    [4, 'galgame', 'touchgal']
  ] as const)('role %i 在 %s 分区的默认存储是 %s', (role, section, storage) => {
    expect(defaultLinkStorage(subjectOf(role), section)).toBe(storage)
  })

  it('游客只能用自定义链接', () => {
    expect(allowedLinkStorages(null, 'patch')).toEqual(['user'])
    expect(defaultLinkStorage({ uid: 0, role: 1 }, 'galgame')).toBe('user')
  })
})

describe('findDisallowedLinkStorage 按 delta 判定', () => {
  const creator = subjectOf(2)
  const admin = subjectOf(3)

  it('没有上一版 (新建) 时每条链接都判', () => {
    expect(
      findDisallowedLinkStorage(admin, {
        section: 'patch',
        links: [{ storage: 'user' }, { storage: 's3' }]
      })
    ).toBeNull()
    expect(
      findDisallowedLinkStorage(admin, {
        section: 'patch',
        links: [{ storage: 'user' }, { storage: 'touchgal' }]
      })
    ).toBe('touchgal')
    expect(
      findDisallowedLinkStorage(creator, {
        section: 'galgame',
        links: [{ storage: 's3' }]
      })
    ).toBe('s3')
  })

  it('存储与分区都没变的存量链接不判, 即使现在已不被允许', () => {
    const previous = {
      section: 'galgame',
      links: [
        { id: 1, storage: 'touchgal' },
        { id: 2, storage: 's3' }
      ]
    }
    expect(findDisallowedLinkStorage(admin, previous, previous)).toBeNull()
    // 同一次保存里新增的链接照判
    expect(
      findDisallowedLinkStorage(
        admin,
        { ...previous, links: [...previous.links, { storage: 'touchgal' }] },
        previous
      )
    ).toBe('touchgal')
  })

  it('换了存储的链接要判', () => {
    expect(
      findDisallowedLinkStorage(
        admin,
        { section: 'patch', links: [{ id: 1, storage: 'touchgal' }] },
        { section: 'patch', links: [{ id: 1, storage: 's3' }] }
      )
    ).toBe('touchgal')
  })

  it('换了分区时全部链接重判: 补丁分区的对象存储不能跟着搬进 Galgame 分区', () => {
    const links = [{ id: 1, storage: 's3' }]
    expect(
      findDisallowedLinkStorage(
        creator,
        { section: 'galgame', links },
        { section: 'patch', links }
      )
    ).toBe('s3')
    expect(
      findDisallowedLinkStorage(
        creator,
        { section: 'patch', links },
        { section: 'galgame', links }
      )
    ).toBeNull()
  })

  it('不认识的存储一律不允许', () => {
    expect(
      findDisallowedLinkStorage(subjectOf(4), {
        section: 'patch',
        links: [{ storage: 'ftp' }]
      })
    ).toBe('ftp')
  })
})

describe('canAssignRole 按 delta 判定', () => {
  it('可授予的角色不含超级管理员', () => {
    expect(KUN_GRANTABLE_ROLES).toEqual([1, 2, 3])
  })

  it('角色没有变化恒放行, 包括超级管理员账号', () => {
    for (const role of ROLES) {
      expect(canAssignRole(subjectOf(4), { current: role, next: role })).toBe(
        true
      )
    }
  })

  it('超级管理员可以把角色改成 1–3, 不能把任何人设成超级管理员', () => {
    const superAdmin = subjectOf(4)
    for (const current of ROLES) {
      for (const next of ROLES) {
        expect(canAssignRole(superAdmin, { current, next })).toBe(
          next === current || next < 4
        )
      }
    }
  })

  it('超级管理员以下不能改任何人的角色', () => {
    for (const role of [1, 2, 3]) {
      expect(canAssignRole(subjectOf(role), { current: 1, next: 2 })).toBe(
        false
      )
      expect(canAssignRole(subjectOf(role), { current: 3, next: 1 })).toBe(
        false
      )
    }
  })

  it('域外的目标角色不可授予', () => {
    expect(canAssignRole(subjectOf(4), { current: 1, next: 0 })).toBe(false)
    expect(canAssignRole(subjectOf(4), { current: 1, next: 5 })).toBe(false)
  })
})

describe('KunActor 品牌', () => {
  it('手写的对象赋不进 KunActor (编译期, 由 pnpm typecheck 执行)', () => {
    // @ts-expect-error 没有经过会话校验的对象没有品牌: 字面量角色传不进收 KunActor 的服务
    const forged: KunActor = { uid: 1, role: 3, name: 'kun' }
    // @ts-expect-error 域外的角色连测试辅助都构造不出来
    kunTestActor({ uid: 1, role: 5 })
    const actor: KunSubject = kunTestActor({ uid: 1, role: 3 })
    expect(can(actor, 'banner.edit')).toBe(can(forged, 'banner.edit'))
  })
})
