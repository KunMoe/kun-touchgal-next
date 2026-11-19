import { beforeEach, describe, expect, it, vi } from 'vitest'

// 令牌解析、暂存校验与转正经 bind 与 complete 的用例在适配器一层钉住
// (app/api/patch/resource/__tests__/bind-uploaded-resource.test.ts、
// app/api/upload/complete/__tests__/route.test.ts); 这里放那两处看不到的: 建暂存对象的
// 函数自己就不放行洗不出名字的上传 (路由挡在它前面), 以及它写下的令牌读得回来
const { presignPutObjectMock, setKvMock, getKvMock } = vi.hoisted(() => ({
  presignPutObjectMock: vi.fn(),
  setKvMock: vi.fn(),
  getKvMock: vi.fn()
}))

vi.mock('~/lib/s3', () => ({ presignPutObject: presignPutObjectMock }))
vi.mock('~/lib/redis', () => ({ setKv: setKvMock, getKv: getKvMock }))

import {
  createStagedUpload,
  readUploadToken
} from '~/server/storage/stagedUpload'

beforeEach(() => {
  vi.resetAllMocks()
  presignPutObjectMock.mockResolvedValue('https://s3.example.com/presigned')
})

describe('createStagedUpload', () => {
  it.each(['game.exe', '😀.zip', 'archive', '.zip'])(
    '文件名 %j 洗不出可用的名字: 不签发上传地址, 不写令牌',
    async (fileName) => {
      const result = await createStagedUpload({
        uid: 7,
        fileName,
        fileSize: 1024
      })

      expect(result).toBe(
        '文件名不可用: 仅支持 .zip .rar .7z 格式, 且文件名需要包含文字或数字, 请改名后重新上传'
      )
      expect(presignPutObjectMock).not.toHaveBeenCalled()
      expect(setKvMock).not.toHaveBeenCalled()
    }
  )

  it('暂存 key 落在 patch/tmp/<uid>/<随机段>/ 之下, 末段是清洗后的名字', async () => {
    const result = await createStagedUpload({
      uid: 7,
      fileName: 'a\n../../b.zip',
      fileSize: 1024
    })

    expect(result).toMatchObject({ expiresIn: 7200 })
    const [s3Key] = presignPutObjectMock.mock.calls[0]
    expect(s3Key).toMatch(/^patch\/tmp\/7\/[0-9a-f]{64}\/ab\.zip$/)
  })
})

// 写令牌与读令牌各有一份对「暂存 key 长什么样」的描述 (拼接与正则), 这里保证两者对得上
describe('createStagedUpload 写下的令牌由 readUploadToken 读回', () => {
  const roundTrip = async (fileName: string) => {
    const created = await createStagedUpload({
      uid: 7,
      fileName,
      fileSize: 2048
    })
    if (typeof created === 'string') {
      throw new Error(created)
    }
    const [kvKey, kvValue] = setKvMock.mock.calls[0]
    expect(kvKey).toBe(`upload:${created.token}`)
    getKvMock.mockResolvedValue(kvValue)

    const meta = await readUploadToken(created.token, 7)
    expect(getKvMock).toHaveBeenCalledWith(kvKey)
    return { stagedKey: presignPutObjectMock.mock.calls[0][0] as string, meta }
  }

  it.each([
    'game.zip',
    'GAME.RAR',
    'ガールズ&パッチ v1.0.zip'.normalize('NFD'),
    'a\n../../b.zip',
    'e.\u0301x.zip',
    `a${'𠮷'.repeat(120)}.7z`
  ])('%j', async (fileName) => {
    const { stagedKey, meta } = await roundTrip(fileName)

    expect(meta).toEqual({
      s3Key: stagedKey,
      fileName: stagedKey.split('/').pop(),
      declared: 2048,
      uid: 7
    })
  })
})
