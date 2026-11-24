import { randomBytes, randomUUID } from 'crypto'

// 图片对象 (头像、封面、编辑器图床) 的 S3 key 布局只在这里定义。资源文件不归这里: 它的 key 落在
// patch_resource_link.s3_key, 由 server/storage/stagedUpload.ts 生成

// 头像正式 S3 key 的唯一定义处 (发布位置, 每用户固定); 审核暂存 key 见
// getUserAvatarPendingKeys —— 刻意分离, 不让暂存对象再共用一个固定 key
export const getUserAvatarKeys = (uid: number) => {
  const dir = `user/avatar/user_${uid}`
  return {
    avatarKey: `${dir}/avatar.avif`,
    avatarMiniKey: `${dir}/avatar-mini.avif`
  }
}

// 每次上传生成唯一、不可变的暂存 key: worker 送审读取、AI 裁决、apply 复制全程绑定
// 同一对象, 并发上传各写各的 key, 杜绝"送审字节 ≠ 落地字节"的审核绕过竞态. pending/
// 前缀便于对暂存对象单独配 S3 lifecycle 过期, 兜底被 supersede 而 apply 不会清理的孤儿
export const getUserAvatarPendingKeys = (uid: number, nonce: string) => {
  const dir = `user/avatar/user_${uid}/pending`
  return {
    pendingKey: `${dir}/${nonce}.avif`,
    pendingMiniKey: `${dir}/${nonce}-mini.avif`
  }
}

// 审核留档 key: 任务创建时把送审对象复制到此处永久保存, 使审核记录在 pending 暂存
// 对象被裁决清理、或正式 key 被后续上传覆盖后仍可回看; 刻意避开 pending/ 前缀,
// 不受暂存对象的 S3 lifecycle 过期影响. 留档站内无任何清理路径、永久累积——这是
// 已知的存储成本取舍 (小 avif 对象、上传受 50 张/日配额约束), 勿给此前缀配过期规则
export const getUserAvatarModerationArchiveKey = (uid: number, nonce: string) =>
  `user/avatar/user_${uid}/moderation/${nonce}.avif`

// 这个用户的审核暂存对象 (getUserAvatarPendingKeys 的形状)。删号时按任务载荷回收暂存对象, 载荷里的
// key 先过这一关, 留档 (moderation/) 与别人的对象一律不认
export const isUserAvatarPendingKey = (uid: number, key: string) =>
  new RegExp(`^user/avatar/user_${uid}/pending/[^/]+\\.avif$`).test(key)

const imageBedUrl = () => process.env.KUN_VISUAL_NOVEL_IMAGE_BED_URL

// 编辑器图床的对象: key 带随机段, 同一用户的两次上传落在同一毫秒也不会互相覆盖 (X06-03)。
// 这些图片可能被别人的内容引用, 站内没有回收路径, 删号也不清
export const newContentImageKey = (uid: number) => {
  const name = `${uid}-${Date.now()}-${randomBytes(4).toString('hex')}`
  const key = `user/image/${uid}/${name}.avif`
  return { key, url: `${imageBedUrl()}/${key}` }
}

// 封面: 一个版本是同一目录下的一组对象 (主图、列表小图、可选的原图大图), patch.banner 存主图的公开
// 地址, 是「当前是哪个版本」的唯一指针。存量指针没有版本段 (patch/{id}/banner/banner.avif), 下一次
// 替换时自然迁走, 不回填
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PATCH_BANNER_DIR = `patch/(\\d+)/banner(?:/${UUID})?`
const PATCH_BANNER_POINTER_PATH = new RegExp(
  `^(${PATCH_BANNER_DIR})/banner\\.avif$`
)
const PATCH_BANNER_KEY = new RegExp(
  `^(${PATCH_BANNER_DIR})/banner(?:-mini|-full)?\\.avif$`
)

const patchBannerKeysIn = (dir: string) => [
  `${dir}/banner.avif`,
  `${dir}/banner-mini.avif`,
  `${dir}/banner-full.avif`
]

// 新版本的对象 key 与指针。目录带随机段: 每次写都是没人引用过、也没人入过删除队列的新 key
// (server/storage/references.ts 的写入不变量)
export const newPatchBannerSet = (patchId: number) => {
  const [main, mini, full] = patchBannerKeysIn(
    `patch/${patchId}/banner/${randomUUID()}`
  )
  return {
    keys: { main, mini, full },
    pointer: `${imageBedUrl()}/${main}`
  }
}

export type PatchBannerSet = ReturnType<typeof newPatchBannerSet>

// 换下来的封面版本留多久再删。共享读缓存里内嵌着封面地址的条目 (详情、列表卡片、资源页, TTL 见
// config/cache.ts) 在过期之前还会把旧地址发给页面, 已经打开的页面也还拿着它; 宽限期必须不短于这些
// TTL (imageObjects.test.ts 核对)。删游戏与「立即删除旧图」不用宽限期
export const IMAGE_VERSION_DELETION_GRACE_MS = 24 * 60 * 60 * 1000

// 指针所指那个版本的全部对象 key, 用来回收。只认「配置的图床前缀 + /」开头、路径严格是本游戏封面
// 的指针, 其余 (外站地址、别的游戏、换过域名的存量、空串) 一律返回 []: 认错的代价是删掉别人的对象,
// 认不出只是留下孤儿。不用 new URL().pathname, 它会接受外站主机。full 不一定存在, 照样返回
// (DeleteObject 删不存在的 key 也成功)
export const patchBannerKeysFromPointer = (
  patchId: number,
  pointer: string
): string[] => {
  const bed = imageBedUrl()
  if (!bed || !pointer.startsWith(`${bed}/`)) {
    return []
  }
  const match = PATCH_BANNER_POINTER_PATH.exec(pointer.slice(bed.length + 1))
  if (!match || match[2] !== String(patchId)) {
    return []
  }
  return patchBannerKeysIn(match[1])
}

// 出箱里的 key 是不是某个封面版本的对象: 返回游戏 id 与版本目录, 供删除前的引用判定
// (server/storage/references.ts) 点查 patch 行
export const parsePatchBannerKey = (key: string) => {
  const match = PATCH_BANNER_KEY.exec(key)
  return match ? { patchId: Number(match[2]), dir: match[1] } : null
}

// 指针是否指向这个版本目录。这是判「仍在使用」的一侧, 宁宽勿严: 不看主机 (换过域名的存量指针照样
// 算在用), 去掉查询串与片段
export const isPatchBannerPointerIn = (pointer: string, dir: string) =>
  pointer.split(/[?#]/)[0].endsWith(`/${dir}/banner.avif`)
