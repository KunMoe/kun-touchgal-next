import { randomBytes } from 'crypto'

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

const imageBedUrl = () => process.env.KUN_VISUAL_NOVEL_IMAGE_BED_URL

// 编辑器图床的对象: key 带随机段, 同一用户的两次上传落在同一毫秒也不会互相覆盖 (X06-03)。
// 这些图片可能被别人的内容引用, 站内没有回收路径, 删号也不清
export const newContentImageKey = (uid: number) => {
  const name = `${uid}-${Date.now()}-${randomBytes(4).toString('hex')}`
  const key = `user/image/${uid}/${name}.avif`
  return { key, url: `${imageBedUrl()}/${key}` }
}
