import { kunMoyuMoe } from '~/config/moyu-moe'
import { kunPageMetadata } from '~/utils/pageMetadata'

export const kunMetadata = kunPageMetadata({
  title: '通知消息',
  description: `这是通知消息页面, 本页面展示了 ${kunMoyuMoe.titleShort} 用户的被赞, 评论, 被回复, 被关注, 关注者, 私信 消息`
})
