export const APPEAL_CONTENT_TYPE = ['comment', 'rating', 'resource'] as const

export type AppealContentType = (typeof APPEAL_CONTENT_TYPE)[number]

export const APPEAL_STATUS_MAP: Record<string, string> = {
  pending: '待处理',
  approved: '已通过',
  rejected: '已拒绝'
}

export const APPEAL_SETTINGS_LINK = '/settings/user?tab=appeal'
// 申诉页默认只显示可申诉内容; 通过的申诉不在其中, 链接带上状态才能直接落到这一条
export const APPEAL_APPROVED_LINK = `${APPEAL_SETTINGS_LINK}&state=approved`

export const APPEAL_RESULT_NOTICE = {
  approved: (label: string) =>
    `您对${label}的申诉已通过人工复核，修改后的内容已恢复展示。`,
  rejected: (label: string) =>
    `您对${label}的申诉未通过人工复核，该内容已被删除。`,
  // 拒绝时内容已被其他操作恢复或删除, 未再执行删除
  rejectedKept: (label: string) =>
    `您对${label}的申诉未通过人工复核，该内容已由管理员另行处理。`
}
