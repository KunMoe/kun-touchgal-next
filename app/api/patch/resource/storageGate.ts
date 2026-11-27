import { can, findDisallowedLinkStorage } from '~/constants/permission'
import { getAppealEditableLinkFields } from '~/utils/appealPayload'
import type { KunActor } from '~/constants/role'
import type { ResourceLinkInput } from '~/validations/patch'

type SubmittedLink = ResourceLinkInput

interface StoredLink {
  id: number
  storage: string
  content: string
  size: string
  code: string
  password: string
}

const LINK_FIELDS = ['content', 'size', 'code', 'password'] as const

// 提交的链接已经过校验, 库里的行未必 (导入、手工写入): 校验层会 trim 提取码
// (validations/patch.ts), 所以拿库里的值比较之前先按同样的方式处理, 否则带首尾空白的
// 旧提取码永远算不成原样带回
const asValidated = (
  field: (typeof LINK_FIELDS)[number],
  stored: StoredLink
) => (field === 'code' ? stored.code.trim() : stored[field])

// 链接是不是原样带回的。归存储所有的字段不许动: 对象存储是对象本身 (带了 uploadToken
// 就是换了对象), 其余存储是申诉也不许改的那些字段 —— TouchGal 资源盘是全部字段。
// 两处读同一张可改字段表, 「这条链接的哪些部分归存储所有」只有一份
const isCarriedBack = (link: SubmittedLink, stored: StoredLink) => {
  if (link.storage !== stored.storage) {
    return false
  }
  if (link.storage === 's3') {
    return !link.uploadToken
  }
  const editable = getAppealEditableLinkFields(link.storage)
  return LINK_FIELDS.every(
    (field) =>
      editable.includes(field) || link[field] === asValidated(field, stored)
  )
}

// 库里的一行只能被认领一次: 同一个 id 提交多次, 多出来的就是新链接
const changedLinks = (
  links: readonly SubmittedLink[],
  stored: readonly StoredLink[]
) => {
  const unclaimed = new Map(stored.map((link) => [link.id, link]))
  return links.filter((link) => {
    const before = link.id === undefined ? undefined : unclaimed.get(link.id)
    if (!before || !isCarriedBack(link, before)) {
      return true
    }
    unclaimed.delete(before.id)
    return false
  })
}

export const MANAGED_OBJECT_LINK_ERROR =
  '本站对象存储里的文件不能填成外部链接, 请选择「对象存储」并上传文件'

// 外链的地址不许指向本站桶里的对象: 那个对象归某条对象存储链接所有, 只有 storage 为 s3
// 的行才算它的引用 (server/storage 的引用裁决同此), 那一行被删掉或换了文件, 对象随之删除,
// 指着它的外链就成了死链。发布 / 编辑经 linkStorageGateError 判, 申诉改链接地址时直接调。
// link 是提交上来的外链, before 是库里同 id 的那一行 (新链接没有)。两条判据:
// - 对象存储的行改成外链却留着对象的地址 (P26-01 的原样形态)。不看域名: 桶的公开地址换过、
//   或环境变量与库里的行对不上时, 按前缀认不出它
// - 地址以桶的公开地址开头。规则之前留下的行不妨碍持有者改别的字段: 存储类型与地址都
//   原样带回的不判
export const pointsAtManagedObject = (
  link: { storage: string; content: string },
  before?: { storage: string; content: string }
) => {
  const content = link.content.trim()
  if (before?.storage === 's3' && before.content.trim() === content) {
    return true
  }
  const base = (
    process.env.NEXT_PUBLIC_KUN_VISUAL_NOVEL_S3_STORAGE_URL ?? ''
  ).replace(/\/+$/, '')
  if (!base || !content.toLowerCase().startsWith(`${base}/`.toLowerCase())) {
    return false
  }
  return !(
    before &&
    before.storage === link.storage &&
    before.content === link.content
  )
}

// 存储 × 分区 × 角色的执法点。创建与更新两个服务都调它; 更新这个服务前台路由与后台包装
// 都经过, 所以同一份资源的每个入口判的是同一条规则。判定本身在 constants/permission, 与
// 发布表单置灰用的是同一组函数; 这里决定哪些链接要判, 并负责拒绝文案。
// previous 是编辑前的分区与链接: 分区没变时, 原样带回的存量链接不判 —— 规则收紧之前留下
// 的链接不妨碍持有者改别的字段, 但动它、克隆它、往上挂新对象都按新链接判。
// 「外链不许指向本站桶里的对象」也在这里判, 所以它同样在快照上判一次、行锁下再判一次
export const linkStorageGateError = (
  actor: KunActor,
  next: { section: string; links: readonly SubmittedLink[] },
  previous?: { section: string; links: readonly StoredLink[] }
): string | null => {
  const judged =
    previous && previous.section === next.section
      ? changedLinks(next.links, previous.links)
      : next.links
  const storage = findDisallowedLinkStorage(actor, next.section, judged)
  if (storage === null) {
    const stored = new Map(
      (previous?.links ?? []).map((link) => [link.id, link])
    )
    return next.links.some(
      (link) =>
        link.storage !== 's3' &&
        pointsAtManagedObject(
          link,
          link.id === undefined ? undefined : stored.get(link.id)
        )
    )
      ? MANAGED_OBJECT_LINK_ERROR
      : null
  }
  if (storage === 'touchgal') {
    return '仅超级管理员可使用 TouchGal 资源盘'
  }
  if (storage === 's3') {
    return can(actor, 'storage.s3')
      ? '您当前的角色不能在该分区使用对象存储, 请改用自定义链接'
      : '您的权限不足, 创作者或者管理员才可以上传文件到对象存储'
  }
  return '非法的资源链接类型'
}
