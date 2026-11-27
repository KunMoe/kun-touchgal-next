import { zodResolver } from '@hookform/resolvers/zod'
import { patchResourceCreateSchema } from '~/validations/patch'
import { toRequest } from './linkDraft'
import type { FieldErrors, Resolver } from 'react-hook-form'
import type { ResourceFormValues, ResourceRequest } from './linkDraft'

const requestResolver = zodResolver(patchResourceCreateSchema) as Resolver<
  ResourceRequest,
  unknown,
  unknown
>

// 表单校验的是将要发出去的请求体 (toRequest 的结果), 不是草稿: 规则只有 validations/patch.ts
// 那一份, 界面上看到的错误就是服务端会报的。错误路径按请求体的字段给出 (links.N.字段),
// 与草稿的下标一一对应
export const resourceFormResolver: Resolver<ResourceFormValues> = async (
  values,
  context,
  options
) => {
  const result = await requestResolver(
    toRequest(values),
    context,
    options as never
  )
  return Object.keys(result.errors).length > 0
    ? {
        values: {},
        errors: result.errors as FieldErrors<ResourceFormValues>
      }
    : { values, errors: {} }
}
