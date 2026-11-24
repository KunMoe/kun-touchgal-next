import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  verifyHeaderCookieMock,
  userFindUniqueMock,
  claimQuotaMock,
  refundQuotaMock,
  invalidateUserSessionMock,
  uploadIntroductionImageMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  claimQuotaMock: vi.fn(),
  refundQuotaMock: vi.fn(),
  invalidateUserSessionMock: vi.fn(),
  uploadIntroductionImageMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: { user: { findUnique: userFindUniqueMock } }
}))

vi.mock('~/app/api/utils/imageQuota', () => ({
  claimDailyImageQuota: claimQuotaMock,
  refundDailyImageQuota: refundQuotaMock
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

// 编码与 S3 写入由 _upload.test.ts 覆盖, 这里只看路由给出的 key 与地址
vi.mock('~/app/api/user/image/_upload', () => ({
  uploadIntroductionImage: uploadIntroductionImageMock
}))

import { POST } from '~/app/api/user/image/route'

const IMAGE_BED_URL = 'https://img.example.test'

const postImage = () => {
  const formData = new FormData()
  formData.append('image', new File([new Uint8Array([1, 2, 3])], 'a.png'))
  return POST(
    new NextRequest('http://localhost/api/user/image', {
      method: 'POST',
      body: formData
    })
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', IMAGE_BED_URL)
  verifyHeaderCookieMock.mockResolvedValue({ uid: 7, name: 'kun', role: 1 })
  userFindUniqueMock.mockResolvedValue({ id: 7 })
  claimQuotaMock.mockResolvedValue(true)
  uploadIntroductionImageMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/user/image', () => {
  // 原先 key 只有 uid 与毫秒时间戳, 同一毫秒的第二次上传静默覆盖第一次 (X06-03)
  it('同一毫秒的两次上传写到不同的 key, 返回的地址就是写入的那个 key', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_732_500_000_000)

    const first = await (await postImage()).json()
    const second = await (await postImage()).json()

    const [firstKey, secondKey] = uploadIntroductionImageMock.mock.calls.map(
      ([key]) => key as string
    )
    expect(firstKey).not.toBe(secondKey)
    expect(firstKey).toMatch(
      /^user\/image\/7\/7-1732500000000-[0-9a-f]{8}\.avif$/
    )
    expect(first).toEqual({ imageLink: `${IMAGE_BED_URL}/${firstKey}` })
    expect(second).toEqual({ imageLink: `${IMAGE_BED_URL}/${secondKey}` })
  })

  it('上传返回错误串时退还额度, 原样返回', async () => {
    uploadIntroductionImageMock.mockResolvedValue('图片体积过大')

    expect(await (await postImage()).json()).toBe('图片体积过大')
    expect(refundQuotaMock).toHaveBeenCalledWith(7)
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })
})
