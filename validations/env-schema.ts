import { z } from 'zod'
// 相对导入: 本文件经 dotenv-check 进入 next.config.ts 的加载链, 不解析 ~ 别名
import { kunOptionalWebUrlSchema, kunWebUrlSchema } from './env-url'

const rawEnvSchema = z.object({
  KUN_DATABASE_URL: z.string().url(),
  KUN_VISUAL_NOVEL_SITE_URL: z.string().url(),

  // DEV 地址仅 dev 分支消费 (kunFetch / 登录重定向 / 邮件模板的 NODE_ENV 三元式),
  // 生产允许缺失或留空; dev 下必填由下方 superRefine 兜住
  NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV: kunOptionalWebUrlSchema,
  NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD: kunWebUrlSchema,

  REDIS_HOST: z.string(),
  REDIS_PORT: z.string(),
  REDIS_PASSWORD: z.string().optional(),

  JWT_ISS: z.string(),
  JWT_AUD: z.string(),
  JWT_SECRET: z.string(),
  KUN_TWO_FACTOR_BACKUP_PEPPER: z.string().min(32),
  KUN_CAP_SECRET: z.string().min(32),

  OIDC_ISSUER: z.string().url().optional(),
  OIDC_JWKS: z.string().optional(),
  OIDC_COOKIE_KEYS: z.string().optional(),
  OIDC_SECRET_ENC_KEY: z.string().optional(),

  NODE_ENV: z.enum(['development', 'test', 'production']),

  KUN_VISUAL_NOVEL_EMAIL_FROM: z.string(),
  KUN_VISUAL_NOVEL_EMAIL_HOST: z.string(),
  KUN_VISUAL_NOVEL_EMAIL_PORT: z.string(),
  KUN_VISUAL_NOVEL_EMAIL_ACCOUNT: z.string(),
  KUN_VISUAL_NOVEL_EMAIL_PASSWORD: z.string(),

  KUN_VISUAL_NOVEL_S3_STORAGE_ACCESS_KEY_ID: z.string(),
  KUN_VISUAL_NOVEL_S3_STORAGE_SECRET_ACCESS_KEY: z.string(),
  KUN_VISUAL_NOVEL_S3_STORAGE_BUCKET_NAME: z.string(),
  KUN_VISUAL_NOVEL_S3_STORAGE_ENDPOINT: z.string(),
  KUN_VISUAL_NOVEL_S3_STORAGE_REGION: z.string(),
  NEXT_PUBLIC_KUN_VISUAL_NOVEL_S3_STORAGE_URL: z.string(),

  KUN_VISUAL_NOVEL_IMAGE_BED_HOST: z.string(),
  KUN_VISUAL_NOVEL_IMAGE_BED_URL: z.string(),

  KUN_CF_CACHE_ZONE_ID: z.string(),
  KUN_CF_CACHE_PURGE_API_TOKEN: z.string(),

  KUN_VISUAL_NOVEL_INDEX_NOW_KEY: z.string(),

  // NextMoe 开放平台 (/v2/moyu 补丁面): 密钥仅限服务端, 留空即关闭鲲补丁资源查询
  KUN_NEXTMOE_API_BASE: kunWebUrlSchema,
  KUN_NEXTMOE_API_KEY: z.string(),

  KUN_ENABLE_CRON: z.enum(['true', 'false']).optional(),
  KUN_VISUAL_NOVEL_TEST_SITE_LABEL: z.string().optional(),

  MODERATION_AI_BASE_URL: z.string().url().optional(),
  MODERATION_AI_API_KEY: z.string().optional(),
  MODERATION_AI_TEXT_MODEL: z.string().optional(),
  MODERATION_AI_TEXT_REASONING_EFFORT: z.string().optional(),
  MODERATION_AI_VISION_MODEL: z.string().optional(),
  MODERATION_AI_VISION_REASONING_EFFORT: z.string().optional(),

  MEILISEARCH_HOST: z.string().url().optional(),
  MEILISEARCH_ADMIN_API_KEY: z.string().optional(),
  KUN_MEILISEARCH_ENABLED: z.enum(['true', 'false']).optional()
})

// OIDC 启用（配置了签名密钥 OIDC_JWKS）时，client_secret 加密 KEK 必填：迁移把密文落库后，
// 一旦 KEK 缺失 / 改动会导致机密 client 全部 500 且密文不可逆恢复，故启动即 fail-fast。
export const envSchema = rawEnvSchema.superRefine((value, ctx) => {
  if (value.OIDC_JWKS && !value.OIDC_SECRET_ENC_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OIDC_SECRET_ENC_KEY'],
      message:
        'OIDC 已启用（OIDC_JWKS 非空）时 OIDC_SECRET_ENC_KEY 必填，请运行 esno scripts/generateOidcJwks.ts 生成'
    })
  }

  // dev 下 DEV 地址是承重值: 缺失会让 kunFetch 拼出 undefined/api/...,
  // 登录重定向 new URL('/login', undefined) 直接 throw, 故启动即 fail-fast
  if (
    value.NODE_ENV === 'development' &&
    !value.NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV'],
      message: 'NODE_ENV=development 时 NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV 必填'
    })
  }
})
