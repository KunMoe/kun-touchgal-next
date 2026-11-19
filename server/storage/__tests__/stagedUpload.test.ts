import { beforeEach, describe, expect, it, vi } from 'vitest'

// 令牌解析、暂存校验与转正经 bind 与 complete 的用例在适配器一层钉住
// (app/api/patch/resource/__tests__/bind-uploaded-resource.test.ts、
// app/api/upload/complete/__tests__/route.test.ts); 这里只放路由挡在前面、从外面
// 到不了的那一条: 建暂存对象的函数自己就不放行洗不出名字的上传
const { presignPutObjectMock, setKvMock } = vi.hoisted(() => ({
  presignPutObjectMock: vi.fn(),
  setKvMock: vi.fn()
}))

vi.mock('~/lib/s3', () => ({ presignPutObject: presignPutObjectMock }))
vi.mock('~/lib/redis', () => ({ setKv: setKvMock }))

import { createStagedUpload } from '~/server/storage/stagedUpload'

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
