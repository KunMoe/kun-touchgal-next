import { markdownToText } from '~/utils/markdownToText'

export const extractMentionUserIds = (text: string) => {
  // 编辑器插入的提及链接指向 /user/{id}/comment, 历史内容存在 /resource 变体
  const regex = /\[@[^\]]+\]\(\/user\/(\d+)\/(?:comment|resource)\)/g
  return [...text.matchAll(regex)].map((match) => Number(match[1]))
}

// 提及通知的正文: 评论者、游戏名, 加评论纯文本的前 50 字
export const buildMentionContent = (
  senderUsername: string,
  patchName: string,
  text: string
) =>
  `${senderUsername} 在「${patchName}」的评论区提到了您\n${markdownToText(text).slice(0, 50)}`
