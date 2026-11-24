import { describe, expect, it } from 'vitest'
import { avatarLargeUrl, bannerVariantUrl } from '~/utils/imageVariant'

// 对照组是收进 helper 之前各组件里手写的表达式 (卡片 5 处 mini、详情灯箱 1 处 full、
// 个人主页 1 处大头像), 逐字照抄: helper 的结果必须与它们逐字节相同
const legacyMini = (banner: string) => banner.replace(/\.avif$/, '-mini.avif')
const legacyFull = (banner: string) =>
  banner.replace('banner.avif', 'banner-full.avif')
const legacyAvatarLarge = (avatar: string) => avatar.replace('-mini', '')

const BED = 'https://img.example.test'
const UUID = '0f8c8a8e-3a3b-4c5d-9e6f-1a2b3c4d5e6f'

const banners = [
  `${BED}/patch/1/banner/banner.avif`,
  `${BED}/patch/10/banner/${UUID}/banner.avif`,
  'https://cloud.touchgaloss.com/patch/14038/banner/banner.avif',
  '/touchgal.avif',
  ''
]

const avatars = [
  `${BED}/user/avatar/user_1/avatar-mini.avif?v=1732500000000`,
  `${BED}/user/avatar/user_1/avatar-mini.avif`,
  ''
]

describe('bannerVariantUrl', () => {
  it.each(banners)('mini 与原卡片表达式一致: %s', (banner) => {
    expect(bannerVariantUrl(banner, 'mini')).toBe(legacyMini(banner))
  })

  it.each(banners)('full 与原灯箱表达式一致: %s', (banner) => {
    expect(bannerVariantUrl(banner, 'full')).toBe(legacyFull(banner))
  })

  // 版本目录名里没有 banner.avif, 替换只落在文件名上
  it('版本目录形态只改文件名', () => {
    const pointer = `${BED}/patch/10/banner/${UUID}/banner.avif`
    expect(bannerVariantUrl(pointer, 'mini')).toBe(
      `${BED}/patch/10/banner/${UUID}/banner-mini.avif`
    )
    expect(bannerVariantUrl(pointer, 'full')).toBe(
      `${BED}/patch/10/banner/${UUID}/banner-full.avif`
    )
  })
})

describe('avatarLargeUrl', () => {
  it.each(avatars)('与原个人主页表达式一致: %s', (avatar) => {
    expect(avatarLargeUrl(avatar)).toBe(legacyAvatarLarge(avatar))
  })
})
