import {
  SUPPORTED_LANGUAGE_MAP,
  SUPPORTED_PLATFORM,
  SUPPORTED_TYPE_MAP
} from '~/constants/resource'
import { kunPageMetadata } from '~/utils/pageMetadata'

export const kunMetadata = kunPageMetadata({
  title: 'Galgame 补丁资源下载',
  description: `最新最全的 Galgame 补丁资源列表, 包括 ${Object.values(SUPPORTED_TYPE_MAP)}, 支持 ${Object.values(SUPPORTED_LANGUAGE_MAP)}, 包含 ${Object.values(SUPPORTED_PLATFORM)} 下载`
})
