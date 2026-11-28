import type { AppealLink, AppealPayload } from '~/types/api/appeal'

export type AppealLinkField = Exclude<keyof AppealLink, 'id' | 'storage'>

// 作者在申诉里可以改一条链接的哪些字段:
//  - 自定义链接 (user) 四个字段都可改
//  - 对象存储 (s3) 的地址与大小由服务端按绑定的上传文件写下, 不是作者填的 (发布 / 编辑
//    表单里同样只读; 地址因此也不送审), 只有提取码与解压码可改
//  - TouchGal 资源盘的链接只有超级管理员能写 (资源发布 / 编辑路由的限制), 作者不能借
//    申诉改它, 整条不可改; 不认识的存储类型同样按不可改处理
// 这只管链接本身: 资源上有不可改的链接, 不影响申诉修改标题、介绍等其它字段。
// 服务端的提交与通过、申诉页的只读态与请求体读的都是这一处
export const getAppealEditableLinkFields = (
  storage: string
): AppealLinkField[] => {
  if (storage === 'user') {
    return ['content', 'size', 'code', 'password']
  }
  return storage === 's3' ? ['code', 'password'] : []
}

// 较早提交的申诉不带模型型号与链接, 通过时这两样保持不变: 展示时补上现有的值, 免得
// 被读成「被删掉了」。申诉自带时一律以申诉为准 —— 管理员复核时看到的必须是将被写回
// 的那一份
export const withUnchangedFields = (
  payload: AppealPayload,
  original: AppealPayload | null
): AppealPayload => ({
  ...payload,
  modelName: payload.modelName ?? original?.modelName,
  links: payload.links ?? original?.links
})

export interface AppealPayloadField {
  label: string
  value: string
}

// 资源申诉内容按字段拆开展示 (字段名与值分列), 不拼成一段文本: 介绍等字段是可以换行的
// 自由文本, 拼在一起时用户能在里面伪造出「链接：…」这样的行, 而管理员复核申诉看的就是
// 这份展示。字段顺序与字段名同送审时一致: 只有一条链接时不带序号; 模型型号 (只有 AI
// 翻译补丁有)、提取码、解压码为空时不出行
export const getResourceAppealFields = (
  payload: AppealPayload
): AppealPayloadField[] => {
  const links = payload.links ?? []
  return [
    { label: '标题', value: payload.name ?? '' },
    { label: '介绍', value: payload.note ?? '' },
    ...(payload.modelName
      ? [{ label: '模型型号', value: payload.modelName }]
      : []),
    ...links.flatMap((link, index) => {
      const suffix = links.length > 1 ? ` ${index + 1}` : ''
      return [
        { label: `链接${suffix}`, value: link.content },
        { label: `大小${suffix}`, value: link.size },
        ...(link.code ? [{ label: `提取码${suffix}`, value: link.code }] : []),
        ...(link.password
          ? [{ label: `解压码${suffix}`, value: link.password }]
          : [])
      ]
    })
  ]
}
