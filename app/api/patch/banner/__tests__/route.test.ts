import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  verifyHeaderCookieMock,
  patchFindUniqueMock,
  uploadPatchBannerMock,
  purgeCloudflareCacheMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  patchFindUniqueMock: vi.fn(),
  uploadPatchBannerMock: vi.fn(),
  purgeCloudflareCacheMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: { patch: { findUnique: patchFindUniqueMock } }
}))

// 横幅编码 (sharp) 与 S3 写入都在 helper 里, 路由测试只覆盖闸门与编排
vi.mock('~/app/api/edit/_upload', () => ({
  uploadPatchBanner: uploadPatchBannerMock
}))

vi.mock('~/app/api/utils/purgeCloudflareCache', () => ({
  purgeCloudflareCache: purgeCloudflareCacheMock
}))

import { POST } from '~/app/api/patch/banner/route'

const IMAGE_BED_URL = 'https://img.example.com'
const PATCH_ID = 42
const IMAGE_BYTES = [1, 2, 3]
const ORIGINAL_BYTES = [4, 5, 6, 7]

const imageFile = (bytes: number[], name = 'banner.png') =>
  new File([new Uint8Array(bytes)], name)

const buildFormData = (fields: Record<string, string | File>) => {
  const formData = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value)
  }
  return formData
}

const validFields = (): Record<string, string | File> => ({
  patchId: String(PATCH_ID),
  image: imageFile(IMAGE_BYTES)
})

const postRequest = (formData: FormData) =>
  new NextRequest('http://localhost/api/patch/banner', {
    method: 'POST',
    body: formData
  })

const asPayload = (role: number) => ({ uid: 7, name: 'kun', role })

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', IMAGE_BED_URL)
  verifyHeaderCookieMock.mockResolvedValue(asPayload(3))
  patchFindUniqueMock.mockResolvedValue({ id: PATCH_ID })
  uploadPatchBannerMock.mockResolvedValue({})
  purgeCloudflareCacheMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/patch/banner 解析与鉴权顺序', () => {
  it('缺少图片时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(
      postRequest(buildFormData({ patchId: String(PATCH_ID) }))
    )

    expect(await res.json()).toBe('请上传文件')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(patchFindUniqueMock).not.toHaveBeenCalled()
    expect(uploadPatchBannerMock).not.toHaveBeenCalled()
  })

  it('空图片在鉴权前被拒', async () => {
    const res = await POST(
      postRequest(
        buildFormData({ patchId: String(PATCH_ID), image: imageFile([]) })
      )
    )

    expect(await res.json()).toBe('上传文件不能为空')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不查 Galgame', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(postRequest(buildFormData(validFields())))

    expect(await res.json()).toBe('用户未登录')
    expect(patchFindUniqueMock).not.toHaveBeenCalled()
    expect(uploadPatchBannerMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/patch/banner 角色矩阵 (按会话 payload.role)', () => {
  it.each([1, 2])(
    'role %i 返回 本页面仅管理员可访问, 不查 Galgame 不上传',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      const res = await POST(postRequest(buildFormData(validFields())))

      expect(await res.json()).toBe('本页面仅管理员可访问')
      expect(patchFindUniqueMock).not.toHaveBeenCalled()
      expect(uploadPatchBannerMock).not.toHaveBeenCalled()
      expect(purgeCloudflareCacheMock).not.toHaveBeenCalled()
    }
  )

  it.each([3, 4])('role %i 通过闸门并完成上传', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await POST(postRequest(buildFormData(validFields())))

    expect(await res.json()).toEqual({})
    expect(uploadPatchBannerMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/patch/banner 通过闸门后的编排', () => {
  it('Galgame 不存在返回 这个 Galgame 不存在, 不上传不清缓存', async () => {
    patchFindUniqueMock.mockResolvedValue(null)
    const res = await POST(postRequest(buildFormData(validFields())))

    expect(await res.json()).toBe('这个 Galgame 不存在')
    expect(patchFindUniqueMock).toHaveBeenCalledWith({
      where: { id: PATCH_ID },
      select: { id: true }
    })
    expect(uploadPatchBannerMock).not.toHaveBeenCalled()
    expect(purgeCloudflareCacheMock).not.toHaveBeenCalled()
  })

  it('上传 helper 返回错误串时原样返回, 不清 CDN 缓存', async () => {
    uploadPatchBannerMock.mockResolvedValue('图片处理失败')
    const res = await POST(postRequest(buildFormData(validFields())))

    expect(await res.json()).toBe('图片处理失败')
    expect(purgeCloudflareCacheMock).not.toHaveBeenCalled()
  })

  it('带原图时把两份字节与 patchId 交给 helper, 并清三条横幅 CDN 地址', async () => {
    const res = await POST(
      postRequest(
        buildFormData({
          ...validFields(),
          imageOriginal: imageFile(ORIGINAL_BYTES, 'original.png')
        })
      )
    )

    expect(await res.json()).toEqual({})
    expect(uploadPatchBannerMock).toHaveBeenCalledTimes(1)
    const [image, patchId, original] = uploadPatchBannerMock.mock.calls[0]
    expect(new Uint8Array(image)).toEqual(new Uint8Array(IMAGE_BYTES))
    expect(patchId).toBe(PATCH_ID)
    expect(new Uint8Array(original)).toEqual(new Uint8Array(ORIGINAL_BYTES))
    expect(purgeCloudflareCacheMock).toHaveBeenCalledWith([
      `${IMAGE_BED_URL}/patch/${PATCH_ID}/banner/banner.avif`,
      `${IMAGE_BED_URL}/patch/${PATCH_ID}/banner/banner-mini.avif`,
      `${IMAGE_BED_URL}/patch/${PATCH_ID}/banner/banner-full.avif`
    ])
  })

  it('未带原图时 helper 第三参为 undefined', async () => {
    await POST(postRequest(buildFormData(validFields())))

    expect(uploadPatchBannerMock.mock.calls[0][2]).toBeUndefined()
  })

  it('CDN 清理失败只记日志, 仍返回 {}', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    purgeCloudflareCacheMock.mockRejectedValue(new Error('cloudflare down'))
    const res = await POST(postRequest(buildFormData(validFields())))

    expect(await res.json()).toEqual({})
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})
