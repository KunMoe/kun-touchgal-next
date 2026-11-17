import { $remark } from '@milkdown/utils'
import { remarkKunDirectives } from '~/utils/markdown/kunDialect'

// 指令语法在编辑器里只注册这一次, 用的是服务端渲染的同一个插件: 已注册的短代码成为
// 视频 / 链接节点 (地址没填的也保留, 卡片上会提示无效), 其余按原文进编辑器。认不出的
// 节点没有这层兜底时, 整个编辑区会初始化失败
export const kunDirectives = $remark(
  'kunDirectives',
  () => remarkKunDirectives,
  { mode: 'edit' as const }
)
