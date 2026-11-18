import { can, findDisallowedLinkStorage } from '~/constants/permission'
import { getAppealEditableLinkFields } from '~/utils/appealPayload'
import type { KunActor } from '~/constants/role'

interface SubmittedLink {
  id?: number
  storage: string
  hash: string
  content: string
  size: string
  code: string
  password: string
}

type StoredLink = Required<SubmittedLink>

const LINK_FIELDS = ['content', 'size', 'code', 'password'] as const

// 链接是不是原样带回的。归存储所有的字段不许动: 对象存储是对象本身 (带了新的上传 token
// 就是换了对象), 其余存储是申诉也不许改的那些字段 —— TouchGal 资源盘是全部字段。
// 两处读同一张可改字段表, 「这条链接的哪些部分归存储所有」只有一份
const isCarriedBack = (link: SubmittedLink, stored: StoredLink) => {
  if (link.storage !== stored.storage) {
    return false
  }
  if (link.storage === 's3') {
    return !link.hash || link.hash === stored.hash
  }
  const editable = getAppealEditableLinkFields(link.storage)
  return (
    link.hash === stored.hash &&
    LINK_FIELDS.every(
      (field) => editable.includes(field) || link[field] === stored[field]
    )
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

// 存储 × 分区 × 角色的执法点。创建与更新两个服务都调它; 更新这个服务前台路由与后台包装
// 都经过, 所以同一份资源的每个入口判的是同一条规则。判定本身在 constants/permission, 与
// 发布表单置灰用的是同一组函数; 这里决定哪些链接要判, 并负责拒绝文案。
// previous 是编辑前的分区与链接: 分区没变时, 原样带回的存量链接不判 —— 规则收紧之前留下
// 的链接不妨碍持有者改别的字段, 但动它、克隆它、往上挂新对象都按新链接判
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
    return null
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
