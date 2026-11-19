import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

// lib/s3 在导入时建客户端。给假凭据与解析不到的端点: 预签名只在本地算签名, 不联网;
// 其余调用都把 send 打桩, 只看发出去的命令
vi.hoisted(() => {
  process.env.KUN_VISUAL_NOVEL_S3_STORAGE_ENDPOINT = 'https://s3.invalid'
  process.env.KUN_VISUAL_NOVEL_S3_STORAGE_REGION = 'us-west-001'
  process.env.KUN_VISUAL_NOVEL_S3_STORAGE_ACCESS_KEY_ID = 'AKIAEXAMPLE'
  process.env.KUN_VISUAL_NOVEL_S3_STORAGE_SECRET_ACCESS_KEY = 'secret'
  process.env.KUN_VISUAL_NOVEL_S3_STORAGE_BUCKET_NAME = 'kun-test'
})

import {
  copyObject,
  headObject,
  presignPutObject,
  promoteObject,
  s3
} from '~/lib/s3'

const STAGING_KEY = 'patch/tmp/7/abc/游戏.zip'
const FINAL_KEY = 'patch/10/resource/def/游戏.zip'

const sendSpy = () => vi.spyOn(s3, 'send').mockResolvedValue({} as never)

const sentCommand = (spy: ReturnType<typeof sendSpy>) => {
  const [command, options] = spy.mock.calls[0] as unknown as [
    { input: Record<string, unknown> },
    unknown
  ]
  return { command, options }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('presignPutObject', () => {
  it('Content-Type 与 Content-Length 都在签名里: 上传者改不了暂存对象的类型与大小', async () => {
    const url = new URL(await presignPutObject(STAGING_KEY, 1234, 7200))

    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host'
    )
  })

  it('地址指向传入的 key, 有效期按传入的秒数', async () => {
    const url = new URL(await presignPutObject(STAGING_KEY, 1234, 7200))

    expect(decodeURIComponent(url.pathname)).toBe(`/kun-test/${STAGING_KEY}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('7200')
  })
})

describe('promoteObject', () => {
  it('复制时重写元数据: 二进制流、按附件下载, 不继承源对象的', async () => {
    const spy = sendSpy()
    const signal = AbortSignal.timeout(1000)

    await promoteObject(STAGING_KEY, FINAL_KEY, signal)

    const { command, options } = sentCommand(spy)
    expect(command).toBeInstanceOf(CopyObjectCommand)
    expect(command.input).toEqual({
      Bucket: 'kun-test',
      CopySource: `kun-test/${encodeURI(STAGING_KEY)}`,
      Key: FINAL_KEY,
      MetadataDirective: 'REPLACE',
      ContentType: 'application/octet-stream',
      ContentDisposition: 'attachment'
    })
    expect(options).toEqual({ abortSignal: signal })
  })
})

describe('copyObject', () => {
  // 头像留档与审核落地的源对象由服务端写入, 要的就是原样继承
  it('不带元数据指令, 目标对象继承源对象的元数据', async () => {
    const spy = sendSpy()

    await copyObject('user/avatar/1/a.avif', 'user/avatar/1/moderation/a.avif')

    const { command } = sentCommand(spy)
    expect(command).toBeInstanceOf(CopyObjectCommand)
    expect(command.input).toEqual({
      Bucket: 'kun-test',
      CopySource: 'kun-test/user/avatar/1/a.avif',
      Key: 'user/avatar/1/moderation/a.avif'
    })
  })
})

describe('headObject', () => {
  it('把墙钟上限传给客户端', async () => {
    const spy = sendSpy()
    const signal = AbortSignal.timeout(1000)

    await headObject(FINAL_KEY, signal)

    const { command, options } = sentCommand(spy)
    expect(command).toBeInstanceOf(HeadObjectCommand)
    expect(command.input).toEqual({ Bucket: 'kun-test', Key: FINAL_KEY })
    expect(options).toEqual({ abortSignal: signal })
  })
})
