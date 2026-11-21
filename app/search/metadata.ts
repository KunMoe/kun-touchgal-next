import { SUPPORTED_TYPE_MAP } from '~/constants/resource'
import { kunPageMetadata } from '~/utils/pageMetadata'

export const kunMetadata = kunPageMetadata({
  title: '搜索 Galgame',
  description: `您可以在此处搜索所有的 Galgame 资源, 包括 ${Object.values(SUPPORTED_TYPE_MAP)} 等等`
})
