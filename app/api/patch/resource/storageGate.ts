import { can, findDisallowedLinkStorage } from '~/constants/permission'
import type { KunLinkStorageState } from '~/constants/permission'
import type { KunActor } from '~/constants/role'

// 存储 × 分区 × 角色的执法点。创建与更新两个服务都调它, 前台路由与后台包装都经过这两个
// 服务, 所以同一份资源的每个入口判的是同一条规则。判定本身在 constants/permission, 与发布
// 表单置灰用的是同一组函数; 这里只负责拒绝文案。
// previous 是编辑前的分区与链接: 只判新增的链接, 以及存储或分区有变化的链接
export const linkStorageGateError = (
  actor: KunActor,
  next: KunLinkStorageState,
  previous?: KunLinkStorageState
): string | null => {
  const storage = findDisallowedLinkStorage(actor, next, previous)
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
