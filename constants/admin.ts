import type { OverviewData } from '~/types/api/admin'

// 批量删除单次上限, 前端分块大小与后端校验共用, 两侧必须一致
export const ADMIN_COMMENT_DELETE_LIMIT = 100
export const ADMIN_RATING_DELETE_LIMIT = 100
export const ADMIN_RESOURCE_DELETE_LIMIT = 100

// admin_log.content 列宽 (VarChar), 超限写入触发 22001 回滚整个事务
export const ADMIN_LOG_CONTENT_LIMIT = 10007

export const APPLICANT_STATUS_MAP: Record<number, string> = {
  0: '待处理',
  1: '已读',
  2: '已通过',
  3: '已拒绝'
}

export const RESOURCE_STATUS_MAP: Record<number, string> = {
  0: '正常',
  1: '隐藏',
  2: '待初次审核',
  3: '待审核'
}

export const ADMIN_LOG_TYPE_MAP: Record<string, string> = {
  create: '创建',
  delete: '删除',
  approve: '通过',
  decline: '拒绝',
  update: '更新'
}

export const ADMIN_STATS_MAP: Record<keyof OverviewData, string> = {
  newUser: '新注册用户',
  newActiveUser: '新活跃用户',
  newGalgame: '新收录 Galgame',
  newGalgameResource: '新上传 Gal 资源',
  newComment: '新评论'
}

export const ADMIN_STATS_SUM_MAP: Record<string, string> = {
  userCount: '用户总数',
  galgameCount: 'Galgame 数量',
  galgameResourceCount: 'Galgame 资源数量',
  galgamePatchResourceCount: 'Galgame 补丁总数',
  galgameCommentCount: '评论总数'
}
