/* eslint-disable no-console */
// 核查对象存储是否执行资源直传的两道控制 (T19 的 S0 ①), 由站长在生产环境人工执行:
//   pnpm exec esno scripts/probeStagedUploadBoundary.ts --write
// 会在 patch/tmp/0/probe-<随机>/ 下写入三个 16 字节的对象, 结束时删除; 不读写数据库。
//
// 1. 预签名 PUT 把 Content-Type 签进签名之后, 换一个类型上传是否被拒 (预期 403)
// 2. 按声明的类型上传是否成功 (预期 200)。前端就是这么传的, 这一条不过不能发布
// 3. promoteObject 是否重写元数据: 源对象是 text/html, 转正后应为二进制流 + attachment
// 4. 经存储公开域名读暂存对象与转正对象, 报告状态码与响应头 (只报告, 不计入通过与否):
//    边缘规则配好之后, patch/tmp/ 下的读取应为 403
// lib/s3 在导入时就用环境变量建客户端, .env 必须先于它加载
import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import {
  deleteFileFromS3,
  headObject,
  presignPutObject,
  promoteObject,
  s3
} from '~/lib/s3'

const BODY = Buffer.from('kun-probe-16byte')
const PUBLIC_HEADERS = [
  'content-type',
  'content-disposition',
  'x-content-type-options'
]

const putWithType = async (url: string, contentType: string) => {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: BODY
  })
  return res.status
}

const reportPublicRead = async (label: string, key: string) => {
  const url = `${process.env.NEXT_PUBLIC_KUN_VISUAL_NOVEL_S3_STORAGE_URL}/${key}`
  try {
    const res = await fetch(url)
    const headers = PUBLIC_HEADERS.map(
      (name) => `${name}=${res.headers.get(name) ?? '(无)'}`
    ).join(', ')
    console.log(`  ${label}: HTTP ${res.status}, ${headers}`)
  } catch (error) {
    console.log(`  ${label}: 请求失败 (${String(error)})`)
  }
}

const main = async () => {
  if (!process.argv.includes('--write')) {
    console.log(
      '本脚本会向桶里写入并删除三个 16 字节的探针对象; 确认后加 --write 执行'
    )
    return
  }

  const prefix = `patch/tmp/0/probe-${randomBytes(8).toString('hex')}`
  const stagedKey = `${prefix}/staged.zip`
  const htmlKey = `${prefix}/source.zip`
  const promotedKey = `${prefix}/promoted.zip`
  const failures: string[] = []
  const check = (passed: boolean, label: string, detail: string) => {
    console.log(`${passed ? '通过' : '未通过'}  ${label}: ${detail}`)
    if (!passed) {
      failures.push(label)
    }
  }

  try {
    const wrongType = await putWithType(
      await presignPutObject(stagedKey, BODY.length, 300),
      'text/html'
    )
    check(wrongType === 403, '1 换类型上传被拒', `HTTP ${wrongType} (预期 403)`)

    const declaredType = await putWithType(
      await presignPutObject(stagedKey, BODY.length, 300),
      'application/octet-stream'
    )
    check(
      declaredType === 200,
      '2 按声明的类型上传成功',
      `HTTP ${declaredType} (预期 200)`
    )

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.KUN_VISUAL_NOVEL_S3_STORAGE_BUCKET_NAME!,
        Key: htmlKey,
        Body: BODY,
        ContentType: 'text/html'
      })
    )
    await promoteObject(htmlKey, promotedKey)
    const promoted = await headObject(promotedKey)
    check(
      promoted.ContentType === 'application/octet-stream' &&
        !!promoted.ContentDisposition?.startsWith('attachment') &&
        promoted.ContentLength === BODY.length,
      '3 转正重写元数据',
      `ContentType=${promoted.ContentType}, ContentDisposition=${promoted.ContentDisposition}, ContentLength=${promoted.ContentLength}`
    )

    console.log('4 经公开域名读取 (只报告):')
    await reportPublicRead('暂存对象 (text/html)', htmlKey)
    await reportPublicRead('转正对象', promotedKey)
  } finally {
    for (const key of [stagedKey, htmlKey, promotedKey]) {
      await deleteFileFromS3(key).catch((error) =>
        console.error(`探针对象未能删除, 请手工清理: ${key}`, error)
      )
    }
  }

  if (failures.length > 0) {
    console.error(`未通过: ${failures.join('; ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
