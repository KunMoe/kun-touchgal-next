import { createSecretBox } from '~/lib/crypto/secretBox'

// OIDC client_secret 落库加密, KEK 是 OIDC_SECRET_ENC_KEY (格式与明文兼容见 lib/crypto/secretBox.ts)。
// oidc-provider 校验 client_secret_basic/post 需要明文，故只能加密落库、在 adapter.find() 解密，
// 不能像 infra 那样只存哈希。
const box = createSecretBox('OIDC_SECRET_ENC_KEY')

export const isEncryptedClientSecret = box.isSealed
export const encryptClientSecret = box.seal
export const decryptClientSecret = box.open
