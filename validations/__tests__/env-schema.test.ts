import { describe, expect, it } from 'vitest'
// 从无副作用的 env-schema import: dotenv-check 顶层缺 .env 即 process.exit(1),
// 会把无 .env 环境 (如 worktree 直跑 vitest) 的纯逻辑测试拖挂
import { envSchema } from '~/validations/env-schema'

const validEnv = {
  KUN_DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/kun',
  KUN_VISUAL_NOVEL_SITE_URL: 'https://www.moyu.moe',
  NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD: 'https://www.moyu.moe',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  JWT_ISS: 'iss',
  JWT_AUD: 'aud',
  JWT_SECRET: 'secret',
  KUN_TWO_FACTOR_BACKUP_PEPPER: 'p'.repeat(32),
  KUN_CAP_SECRET: 's'.repeat(32),
  NODE_ENV: 'production',
  KUN_VISUAL_NOVEL_EMAIL_FROM: 'from',
  KUN_VISUAL_NOVEL_EMAIL_HOST: 'host',
  KUN_VISUAL_NOVEL_EMAIL_PORT: '465',
  KUN_VISUAL_NOVEL_EMAIL_ACCOUNT: 'account',
  KUN_VISUAL_NOVEL_EMAIL_PASSWORD: 'password',
  KUN_VISUAL_NOVEL_S3_STORAGE_ACCESS_KEY_ID: 'key',
  KUN_VISUAL_NOVEL_S3_STORAGE_SECRET_ACCESS_KEY: 'secret',
  KUN_VISUAL_NOVEL_S3_STORAGE_BUCKET_NAME: 'bucket',
  KUN_VISUAL_NOVEL_S3_STORAGE_ENDPOINT: 'endpoint',
  KUN_VISUAL_NOVEL_S3_STORAGE_REGION: 'region',
  NEXT_PUBLIC_KUN_VISUAL_NOVEL_S3_STORAGE_URL: 'https://img.moyu.moe',
  KUN_VISUAL_NOVEL_IMAGE_BED_HOST: 'img.moyu.moe',
  KUN_VISUAL_NOVEL_IMAGE_BED_URL: 'https://img.moyu.moe',
  KUN_CF_CACHE_ZONE_ID: 'zone',
  KUN_CF_CACHE_PURGE_API_TOKEN: 'token',
  KUN_VISUAL_NOVEL_INDEX_NOW_KEY: 'key',
  KUN_NEXTMOE_API_BASE: 'https://api.nextmoe.dev',
  KUN_NEXTMOE_API_KEY: ''
}

describe('envSchema: DEV 地址生产可留空、dev 必填', () => {
  it('production 下 DEV 键缺失通过', () => {
    expect(envSchema.safeParse(validEnv).success).toBe(true)
  })

  it('production 下 DEV 显式空串通过', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV: ''
    })
    expect(result.success).toBe(true)
  })

  it('development 下 DEV 空串被拒且 issue 指向该字段', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      NODE_ENV: 'development',
      NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV: ''
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual([
        'NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV'
      ])
    }
  })

  it('development 下 DEV 键缺失被拒', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      NODE_ENV: 'development'
    })
    expect(result.success).toBe(false)
  })

  it('development 下 DEV 为合法 URL 通过', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      NODE_ENV: 'development',
      NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV: 'http://127.0.0.1:3000'
    })
    expect(result.success).toBe(true)
  })

  it('production 下 DEV 非空坏值仍被拒 (保留 1ee19f28 的收紧语义)', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV: 'localhost:3000'
    })
    expect(result.success).toBe(false)
  })
})
