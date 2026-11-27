import { zodResolver } from '@hookform/resolvers/zod'
import {
  RESOURCE_UPLOAD_REQUIRED,
  patchResourceCreateSchema
} from '~/validations/patch'
import { linkView, toRequest } from './linkDraft'
import type { FieldError, FieldErrors, Resolver } from 'react-hook-form'
import type { ResourceFormValues, ResourceRequest } from './linkDraft'

const requestResolver = zodResolver(patchResourceCreateSchema) as Resolver<
  ResourceRequest,
  unknown,
  unknown
>

type LinkErrors = Record<string, FieldError | undefined>

// 表单校验的是将要发出去的请求体 (toRequest 的结果), 不是草稿: 规则只有 validations/patch.ts
// 那一份, 界面上看到的错误就是服务端会报的。错误路径按请求体的字段给出 (links.N.字段),
// 与草稿的下标一一对应。
// 另补一条请求体表达不了的: 已有的外链 (带 id) 换到对象存储却还没有文件。请求体里它是
// 「只带 id 的对象存储链接」, 与沿用原文件的长得一样, 过得了 schema, 要到保存时才被服务端
// 拒绝; 草稿知道它在等上传
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
  const errors = result.errors as Record<string, unknown>
  values.links.forEach((link, index) => {
    if (linkView(link) !== 's3-awaiting-upload') {
      return
    }
    const links = (errors.links ??= []) as Record<number, LinkErrors>
    links[index] = {
      ...links[index],
      uploadToken: links[index]?.uploadToken ?? {
        type: 'custom',
        message: RESOURCE_UPLOAD_REQUIRED
      }
    }
  })
  return Object.keys(errors).length > 0
    ? {
        values: {},
        errors: errors as FieldErrors<ResourceFormValues>
      }
    : { values, errors: {} }
}
