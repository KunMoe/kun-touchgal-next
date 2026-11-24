// 封面与头像的派生变体按文件名约定与主图放在同一目录 (服务端写入见
// server/storage/imageObjects.ts), 页面只拿到主图地址, 变体地址在这里按同一约定推出来。
// 版本放在路径段 (patch/{id}/banner/{uuid}/banner.avif), 这几条替换对新旧两种形态都成立;
// 不要把版本挪进查询串, 那样 mini 的 `.avif$` 就失配了

// mini 是列表卡片用的小图; full 是带原图上传时才有的大图, 没有时探测会 404, 由调用方回落
export const bannerVariantUrl = (pointer: string, variant: 'mini' | 'full') =>
  variant === 'mini'
    ? pointer.replace(/\.avif$/, '-mini.avif')
    : pointer.replace('banner.avif', 'banner-full.avif')

// user.avatar 存的是小图 (avatar-mini.avif), 个人主页要大图
export const avatarLargeUrl = (pointer: string) => pointer.replace('-mini', '')
