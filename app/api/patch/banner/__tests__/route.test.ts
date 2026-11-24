import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  verifyHeaderCookieMock,
  patchFindUniqueMock,
  encodePatchBannerMock,
  replacePatchBannerMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  patchFindUniqueMock: vi.fn(),
  encodePatchBannerMock: vi.fn(),
  replacePatchBannerMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: { patch: { findUnique: patchFindUniqueMock } }
}))

// 横幅编码 (sharp) 与版本目录的写入、换指针各有自己的测试 (_upload.test.ts、patchBanner.test.ts),
// 路由测试只覆盖闸门与编排
vi.mock('~/app/api/edit/_upload', () => ({
  encodePatchBanner: encodePatchBannerMock
}))

vi.mock('~/server/storage/patchBanner', () => ({
  replacePatchBanner: replacePatchBannerMock
}))

import { POST } from '~/app/api/patch/banner/route'

const PATCH_ID = 42
const NEW_BANNER = 'https://img.example.com/patch/42/banner/v/banner.avif'
const ENCODED = { banner: Buffer.from('b'), miniBanner: Buffer.from('m') }
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
  verifyHeaderCookieMock.mockResolvedValue(asPayload(3))
  patchFindUniqueMock.mockResolvedValue({ id: PATCH_ID })
  encodePatchBannerMock.mockResolvedValue(ENCODED)
  replacePatchBannerMock.mockResolvedValue({ banner: NEW_BANNER })
})

afterEach(() => {
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
    expect(encodePatchBannerMock).not.toHaveBeenCalled()
    expect(replacePatchBannerMock).not.toHaveBeenCalled()
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
    expect(encodePatchBannerMock).not.toHaveBeenCalled()
    expect(replacePatchBannerMock).not.toHaveBeenCalled()
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
      expect(encodePatchBannerMock).not.toHaveBeenCalled()
      expect(replacePatchBannerMock).not.toHaveBeenCalled()
    }
  )

  it.each([3, 4])('role %i 通过闸门并完成上传', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await POST(postRequest(buildFormData(validFields())))

    expect(await res.json()).toEqual({ banner: NEW_BANNER })
    expect(replacePatchBannerMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/patch/banner 通过闸门后的编排', () => {
  it('Galgame 不存在返回 这个 Galgame 不存在, 不编码不写入', async () => {
    patchFindUniqueMock.mockResolvedValue(null)
    const res = await POST(postRequest(buildFormData(validFields())))

    expect(await res.json()).toBe('这个 Galgame 不存在')
    expect(patchFindUniqueMock).toHaveBeenCalledWith({
      where: { id: PATCH_ID },
      select: { id: true }
    })
    expect(encodePatchBannerMock).not.toHaveBeenCalled()
    expect(replacePatchBannerMock).not.toHaveBeenCalled()
  })

  it('编码返回错误串时原样返回, 不写入', async () => {
    encodePatchBannerMock.mockResolvedValue('图片尺寸过大')
    const res = await POST(postRequest(buildFormData(validFields())))

    expect(await res.json()).toBe('图片尺寸过大')
    expect(replacePatchBannerMock).not.toHaveBeenCalled()
  })

  it('带原图时两份字节都交给编码, 编码结果与 patchId 交给 replacePatchBanner, 回出新地址', async () => {
    const res = await POST(
      postRequest(
        buildFormData({
          ...validFields(),
          imageOriginal: imageFile(ORIGINAL_BYTES, 'original.png')
        })
      )
    )

    expect(await res.json()).toEqual({ banner: NEW_BANNER })
    const [image, original] = encodePatchBannerMock.mock.calls[0]
    expect(new Uint8Array(image)).toEqual(new Uint8Array(IMAGE_BYTES))
    expect(new Uint8Array(original)).toEqual(new Uint8Array(ORIGINAL_BYTES))
    expect(replacePatchBannerMock).toHaveBeenCalledWith(PATCH_ID, ENCODED, {
      discardOld: false
    })
  })

  it('未带原图时编码第二参为 undefined', async () => {
    await POST(postRequest(buildFormData(validFields())))

    expect(encodePatchBannerMock.mock.calls[0][1]).toBeUndefined()
  })

  it('discardOld=true 时要求立即删除旧版本', async () => {
    await POST(
      postRequest(buildFormData({ ...validFields(), discardOld: 'true' }))
    )

    expect(replacePatchBannerMock).toHaveBeenCalledWith(PATCH_ID, ENCODED, {
      discardOld: true
    })
  })

  it('replacePatchBanner 返回错误串时原样返回', async () => {
    replacePatchBannerMock.mockResolvedValue('这个 Galgame 不存在')
    const res = await POST(postRequest(buildFormData(validFields())))

    expect(await res.json()).toBe('这个 Galgame 不存在')
  })
})
