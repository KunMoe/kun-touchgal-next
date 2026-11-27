import type * as z from 'zod'
import type { KunLinkStorage } from '~/constants/permission'
import type { PatchResource } from '~/types/api/patch'
import type { patchResourceCreateSchema } from '~/validations/patch'

// 发布 / 编辑资源表单里的「链接草稿」: 一条链接在表单里是什么形状、每个动作之后变成什么,
// 只在这个模块里定 (T45)。纯 TS, 不依赖 React 与 react-hook-form: 组件只负责把事件交给
// 这里的函数、把结果写回表单, 规则由 __tests__/linkDraft.test.ts 守着。
// 请求体只从 toRequest 出: 草稿里只给界面用的字段 (key、origin、上传的文件名) 与读模型
// 的字段都留在客户端

export type ExternalLinkStorage = Exclude<KunLinkStorage, 's3'>

// 编辑之前这条链接在库里的样子。只读: 用来展示保留着的原文件, 以及在换文件、换存储之后
// 判断「保存会不会删掉原文件」
export interface LinkOrigin {
  storage: string
  content: string
  size: string
}

interface DraftBase {
  // 草稿在本次表单里的身份: React key 与异步结果写回时的寻址都用它。数组下标会随增删变,
  // react-hook-form 的 field.id 在整体替换数组时会重新生成, 都不能当身份
  key: string
  // 库里的链接 id, 新加的链接没有
  id?: number
  code: string
  password: string
  origin: LinkOrigin | null
}

export interface UploadedFile {
  token: string
  fileName: string
  size: string
}

// 对象存储: 地址与大小归服务端 (绑定上传文件时写下), 草稿里只有「挂着哪次上传」
export interface S3LinkDraft extends DraftBase {
  storage: 's3'
  upload: UploadedFile | null
}

export interface ExternalLinkDraft extends DraftBase {
  storage: ExternalLinkStorage
  content: string
  size: string
}

export type ResourceLinkDraft = S3LinkDraft | ExternalLinkDraft

export type ResourceRequest = z.input<typeof patchResourceCreateSchema>

export type ResourceFormValues = Omit<ResourceRequest, 'links'> & {
  links: ResourceLinkDraft[]
}

let keySeq = 0
const nextKey = () => `link-${++keySeq}`

export const emptyLink = (storage: KunLinkStorage): ResourceLinkDraft => {
  const base = { key: nextKey(), code: '', password: '', origin: null }
  return storage === 's3'
    ? { ...base, storage, upload: null }
    : { ...base, storage, content: '', size: '' }
}

// 逐字段取, 不展开 resource: 读模型多出来的字段 (user、点赞数、下载数…) 不进表单
export const fromResource = (resource: PatchResource): ResourceFormValues => ({
  patchId: resource.patchId,
  section: resource.section,
  name: resource.name,
  note: resource.note,
  type: resource.type,
  language: resource.language,
  platform: resource.platform,
  // 旧缓存里的资源可能缺这两个字段: 补上, 保持受控输入
  emulatorType: resource.emulatorType ?? [],
  modelName: resource.modelName ?? '',
  links: resource.links.map((link): ResourceLinkDraft => {
    const base = {
      key: nextKey(),
      id: link.id,
      code: link.code,
      password: link.password,
      origin: { storage: link.storage, content: link.content, size: link.size }
    }
    return link.storage === 's3'
      ? { ...base, storage: 's3', upload: null }
      : {
          ...base,
          // 库里不认识的存储类型按外链带回, 由服务端的校验拒绝
          storage: link.storage as ExternalLinkStorage,
          content: link.content,
          size: link.size
        }
  })
})

export type LinkView =
  // 外链: 地址与大小由用户填
  | 'external'
  // 对象存储, 沿用库里的原文件
  | 's3-kept'
  // 对象存储, 还没有文件
  | 's3-awaiting-upload'
  // 对象存储, 挂着一次刚传完的上传
  | 's3-uploaded'

export const linkView = (link: ResourceLinkDraft): LinkView => {
  if (link.storage !== 's3') {
    return 'external'
  }
  if (link.upload) {
    return 's3-uploaded'
  }
  return link.origin?.storage === 's3' ? 's3-kept' : 's3-awaiting-upload'
}

// 原来是对象存储的链接改成了外链: 保存之后库里的原文件会被删掉, 界面据此提示
export const releasesStoredFile = (link: ResourceLinkDraft) =>
  link.origin?.storage === 's3' && link.storage !== 's3'

// 换存储类型。两个方向各自交出归对方所有的字段:
// - 换到对象存储: 地址与大小不带过去 (它们归上传的文件); 原来就是对象存储的链接回到
//   「沿用原文件」
// - 离开对象存储: 上传与原文件的地址都不带过去, 地址由用户重新填。把对象的地址留在外链里,
//   保存时对象被删, 留下的就是一条死链 (P26-01)
// - 外链之间互换: 地址与大小是用户填的, 原样带着
export const switchStorage = (
  link: ResourceLinkDraft,
  storage: KunLinkStorage
): ResourceLinkDraft => {
  if (link.storage === storage) {
    return link
  }
  const base = {
    key: link.key,
    id: link.id,
    code: link.code,
    password: link.password,
    origin: link.origin
  }
  if (storage === 's3') {
    return { ...base, storage, upload: null }
  }
  return link.storage === 's3'
    ? { ...base, storage, content: '', size: '' }
    : { ...base, storage, content: link.content, size: link.size }
}

// 上传完成的结果按 key 找回它的链接。发起上传之后这条链接可能已被删掉、换了存储类型,
// 或者排在它前面的链接被删了 (下标变了): 找不到对象存储形态的那一条就原样返回, 结果作废,
// 不会写到别的链接上, 也不会凭空多出一项 (P26-02)
export const attachUpload = (
  links: readonly ResourceLinkDraft[],
  key: string,
  upload: UploadedFile
): readonly ResourceLinkDraft[] => {
  const index = links.findIndex(
    (link) => link.key === key && link.storage === 's3'
  )
  if (index === -1) {
    return links
  }
  return links.map((link, at) =>
    at === index && link.storage === 's3' ? { ...link, upload } : link
  )
}

// 移除刚传的文件: 只摘掉这次上传。原来有文件的链接回到「沿用原文件」, 不连带丢掉它
export const discardUpload = (link: ResourceLinkDraft): ResourceLinkDraft =>
  link.storage === 's3' && link.upload ? { ...link, upload: null } : link

// 表单 → 请求体, 唯一的出口
export const toRequest = (values: ResourceFormValues): ResourceRequest => ({
  patchId: values.patchId,
  section: values.section,
  name: values.name,
  note: values.note,
  type: values.type,
  language: values.language,
  platform: values.platform,
  emulatorType: values.emulatorType,
  modelName: values.modelName,
  links: values.links.map((link) =>
    link.storage === 's3'
      ? {
          id: link.id,
          storage: link.storage,
          // 线上契约里上传 token 仍借 hash 字段传 (下一片改成独立的 uploadToken)
          hash: link.upload?.token ?? '',
          content: '',
          size: link.upload?.size ?? link.origin?.size ?? '',
          code: link.code,
          password: link.password
        }
      : {
          id: link.id,
          storage: link.storage,
          hash: '',
          content: link.content,
          size: link.size,
          code: link.code,
          password: link.password
        }
  )
})
