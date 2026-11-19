// 账号删除后, 断开归属的记录 (标签、会社、审核黑名单、管理日志) 在作者位置显示的名字
export const DELETED_USER_NAME = '已注销用户'

export const USER_STATUS_MAP: Record<number, string> = {
  0: '正常',
  1: '限制（正在开发中）',
  2: '封禁'
}

export const USER_STATUS_COLOR_MAP: Record<
  number,
  'success' | 'warning' | 'danger'
> = {
  0: 'success',
  1: 'warning',
  2: 'danger'
}
