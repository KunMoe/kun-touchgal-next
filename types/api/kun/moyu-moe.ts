// NextMoe /v2/moyu 补丁面的响应子集, 契约见 https://developer.nextmoe.dev/specs/moyu-openapi.yaml
// 资源行按契约不带下载直链、提取码与解压码, 下载一律经 web_url 跳转 moyu.moe

export interface KunMoyuPublisher {
  id: string
  name: string
  avatar_url: string
  web_url: string
}

export interface KunMoyuPatchResource {
  id: string
  patch_id: string
  name: string
  storage: 's3' | 'user'
  size: string
  model_name: string
  localization_group_name: string
  note: string
  type: string[]
  language: string[]
  platform: string[]
  download_count: number
  web_url: string
  created_at: string
  updated_at: string
  // 请求恒带 include=publisher, 故必有
  publisher: KunMoyuPublisher
}

export interface KunMoyuPatch {
  id: string
  vndb_id: string
  resources?: KunMoyuPatchResource[]
}

export interface KunMoyuPatchList {
  items: KunMoyuPatch[]
  missing?: string[]
}
