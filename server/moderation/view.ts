import { markdownToHtml } from '~/app/api/utils/render/markdownToHtml'
import { markdownToHtmlComment } from '~/app/api/utils/render/markdownToHtmlComment'
import { kunHtmlToText } from '~/server/content/text'
import type { KunSafeHtml } from '~/types/content'
import { sliceCodePoints, stripInvisible } from '~/utils/text/unicode'
import { normalizeModerationText } from './prefilter'
import { segmentMaxLength } from './subject'
import type { ModerationSubject, SegmentKind } from './subject'

// 送审视图: 由落库的原始段派生「读者将看到的」文本。只由审核 worker 调用 ——
// 渲染放在这里而不是写入请求里, 写路径不为送审多渲染一遍

export interface AuditSegment {
  label: string
  // 读者看到的文字: plain 段就是原值; markdown 段是渲染结果的纯文本投影
  shown: string
  // markdown 段的原文, 仅在与 shown 不等价时给出
  source?: string
}

// 与展示用的是同一个处理器: 哪种语法可见由渲染器决定, 不由送审侧的正则猜
const RENDERERS: Record<
  Exclude<SegmentKind, 'plain'>,
  (markdown: string) => Promise<KunSafeHtml>
> = {
  'markdown-comment': markdownToHtmlComment,
  'markdown-standard': markdownToHtml
}

const isLongForm = (kind: SegmentKind) => kind === 'markdown-standard'

// markdown 段必须两面都审, 只审任何一面都会漏:
// - 行内标记、内嵌标签拆开的词 (98**76**54321) 只有渲染后才连成读者看到的样子;
// - 指令、HTML 块、HTML 注释渲染后不可见, 原文却会出现在通知与个人主页里。
// 两面归一化后相同时只送原文; 渲染抛错或结果为空时同样只送原文
const viewOfMarkdown = async (
  label: string,
  kind: Exclude<SegmentKind, 'plain'>,
  source: string
): Promise<AuditSegment> => {
  let shown = ''
  try {
    shown = kunHtmlToText(await RENDERERS[kind](source), 'audit')
  } catch {
    shown = ''
  }
  if (
    !shown ||
    normalizeModerationText(shown) === normalizeModerationText(source)
  ) {
    return { label, shown: source }
  }
  return { label, shown, source }
}

export const buildAuditView = async (
  subject: Pick<ModerationSubject, 'contentType' | 'segments'>
): Promise<AuditSegment[]> => {
  const visible = subject.segments.filter((segment) =>
    stripInvisible(segment.value).trim()
  )
  // 长文介绍排到最后: 标题、型号这些短字段不会被它挤到后面
  const ordered = [
    ...visible.filter((segment) => !isLongForm(segment.kind)),
    ...visible.filter((segment) => isLongForm(segment.kind))
  ]

  return Promise.all(
    ordered.map(({ label, kind, value }) => {
      // 每段各自限长到该字段写入校验允许的上限 (按码点, 不劈开代理对): 通过校验的
      // 内容整段送审, 任何一段都挤占不了别的字段
      const limit = segmentMaxLength(subject.contentType, label)
      const source = limit === undefined ? value : sliceCodePoints(value, limit)
      return kind === 'plain'
        ? { label, shown: source }
        : viewOfMarkdown(label, kind, source)
    })
  )
}
