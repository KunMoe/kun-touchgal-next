import { kunFriends } from '~/config/friend'
import { kunPageMetadata } from '~/utils/pageMetadata'

const friendName = kunFriends.map((f) => f.name)

export const kunMetadata = kunPageMetadata({
  title: '友情链接',
  description: `点击以进入 ${friendName}`
})
