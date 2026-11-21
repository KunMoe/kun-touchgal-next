import { kunMoyuMoe } from '~/config/moyu-moe'
import { kunPageMetadata } from '~/utils/pageMetadata'

export const kunMetadata = kunPageMetadata({
  title: '系统消息',
  description: `这是系统消息页面, 本页面展示了 ${kunMoyuMoe.titleShort} 系统发送给全体用户的消息`
})
