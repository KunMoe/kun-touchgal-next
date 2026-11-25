import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto'

// 需要还原明文的秘密落库加密 (OIDC client_secret、TOTP 种子): AES-256-GCM, KEK 由环境变量
// 经 SHA-256 派生成 32 字节。存储格式 `gcm:` + base64url(iv(12) ‖ ciphertext ‖ tag(16));
// 没有前缀的值视为历史明文, 原样返回, 回填之前与之后都能读。
// 校验时要明文的秘密才放这里; 只需比对的 (密码、备份码) 存哈希, 见 prisma/columnPolicy.ts
// 的 SECRET_STORAGE
const SCHEME_PREFIX = 'gcm:'
const IV_BYTES = 12
const TAG_BYTES = 16

export interface SecretBox {
  seal(plaintext: string): string
  // 密文被改过或 KEK 不对时抛错 (GCM 认证失败)
  open(stored: string): string
  isSealed(stored: string): boolean
}

// KEK 每次使用时才读: 模块可以在没配置的进程里被导入 (构建、测试), 用到才报错
export const createSecretBox = (kekEnvName: string): SecretBox => {
  const deriveKek = () => {
    const secret = process.env[kekEnvName]
    if (!secret) {
      throw new Error(`${kekEnvName} 未配置，无法加解密`)
    }
    return createHash('sha256').update(secret).digest()
  }

  const isSealed = (stored: string) => stored.startsWith(SCHEME_PREFIX)

  return {
    isSealed,
    seal(plaintext) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', deriveKek(), iv)
      const enc = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
      ])
      const tag = cipher.getAuthTag()
      return SCHEME_PREFIX + Buffer.concat([iv, enc, tag]).toString('base64url')
    },
    open(stored) {
      if (!isSealed(stored)) {
        return stored
      }
      const raw = Buffer.from(stored.slice(SCHEME_PREFIX.length), 'base64url')
      const iv = raw.subarray(0, IV_BYTES)
      const tag = raw.subarray(raw.length - TAG_BYTES)
      const enc = raw.subarray(IV_BYTES, raw.length - TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', deriveKek(), iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
        'utf8'
      )
    }
  }
}
