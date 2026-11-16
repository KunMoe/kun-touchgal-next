import { Fragment } from 'react'
import { getResourceAppealFields } from '~/utils/appealPayload'
import type { AppealPayload } from '~/types/api/appeal'

interface Props {
  contentType: string
  payload: AppealPayload
}

// 申诉卡片 (用户端与管理端) 里「原内容 / 申诉内容」的展示。评论、评价只有一段文字;
// 资源逐字段成行, 字段名与值分列
export const KunAppealPayload = ({ contentType, payload }: Props) => {
  if (contentType !== 'resource') {
    return <p className="whitespace-pre-wrap break-all">{payload.text ?? ''}</p>
  }

  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {getResourceAppealFields(payload).map((field) => (
        <Fragment key={field.label}>
          <dt className="text-default-500">{field.label}</dt>
          <dd className="whitespace-pre-wrap break-all">{field.value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}
