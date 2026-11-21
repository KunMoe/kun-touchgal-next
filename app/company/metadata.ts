import { SUPPORTED_TYPE_MAP } from '~/constants/resource'
import { kunPageMetadata } from '~/utils/pageMetadata'

export const kunMetadata = kunPageMetadata({
  title: `Galgame 会社分类`,
  description: `所有的 Galgame 会社分类, ${Object.values(SUPPORTED_TYPE_MAP).toString()} 下载`
})
