import { kunPageMetadata } from '~/utils/pageMetadata'

// 地址里的 uid 随便填什么页面都回 200 (会话不存在时是一句提示), 不声明 noindex 的话
// 每个 uid 都是一个内容相同的可索引页
export const kunMetadata = kunPageMetadata({ title: '授权确认', noindex: true })
