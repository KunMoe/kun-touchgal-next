import type { OverviewData } from '~/types/api/admin'

// 批量删除单次上限, 前端分块大小与后端校验共用, 两侧必须一致
export const ADMIN_COMMENT_DELETE_LIMIT = 100
export const ADMIN_RATING_DELETE_LIMIT = 100
export const ADMIN_RESOURCE_DELETE_LIMIT = 100

// admin_log.content 列宽 (VarChar), 超限写入触发 22001 回滚整个事务
export const ADMIN_LOG_CONTENT_LIMIT = 10007

// 群发邮件标题与正文的长度上限, 即 mail_campaign 对应两列的列宽
export const MAIL_CAMPAIGN_TITLE_LIMIT = 233
export const MAIL_CAMPAIGN_CONTENT_LIMIT = 100007

// 群发邮件任务的推进节奏 (server/mail/campaign.ts)。每批并发发出 BATCH_SIZE 封, 批间至少
// 隔 MIN_BATCH_INTERVAL_MS: 验证码、重置密码邮件与它走同一个中继, 调高之前先确认中继的
// 承受能力
export const MAIL_CAMPAIGN_BATCH_SIZE = 100
export const MAIL_CAMPAIGN_MIN_BATCH_INTERVAL_MS = 1000
// 定时任务每分钟一拍, 每拍在这个预算内连续发若干批, 用完就等下一拍。它加上批间隔与
// 单封邮件的超时必须小于一分钟, 否则一拍会压到下一拍 (测试钉住这条关系)
export const MAIL_CAMPAIGN_STEP_BUDGET_MS = 40 * 1000
// 一批里失败的比例达到它就自动暂停。没有这一条, 中继宕机时游标会一路越过全体收件人,
// 把他们全部记成失败然后宣告完成
export const MAIL_CAMPAIGN_PAUSE_FAILURE_RATIO = 0.5
// 后台列出最近多少条任务
export const MAIL_CAMPAIGN_LIST_SIZE = 10

export const MAIL_CAMPAIGN_STATUS_MAP: Record<string, string> = {
  sending: '发送中',
  paused: '已暂停',
  done: '已完成',
  cancelled: '已取消'
}

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
