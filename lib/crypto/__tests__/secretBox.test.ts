import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSecretBox } from '~/lib/crypto/secretBox'
import {
  decryptClientSecret,
  encryptClientSecret,
  isEncryptedClientSecret
} from '~/lib/oidc/secret'

const KEK_ENV = 'KUN_TEST_SECRET_BOX_KEK'
const box = createSecretBox(KEK_ENV)

afterEach(() => {
  vi.unstubAllEnvs()
})

const withKek = (kek = 'test-only-secret-box-kek-0123456789') =>
  vi.stubEnv(KEK_ENV, kek)

describe('createSecretBox', () => {
  it('seals to a prefixed ciphertext that opens back to the plaintext', () => {
    withKek()
    const sealed = box.seal('JBSWY3DPEHPK3PXP')

    expect(sealed).toMatch(/^gcm:[A-Za-z0-9_-]+$/)
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP')
    expect(box.isSealed(sealed)).toBe(true)
    expect(box.open(sealed)).toBe('JBSWY3DPEHPK3PXP')
  })

  it('uses a fresh IV every time', () => {
    withKek()

    expect(box.seal('same')).not.toBe(box.seal('same'))
  })

  it('reads a value without the prefix as legacy plaintext, without needing the KEK', () => {
    expect(box.isSealed('JBSWY3DPEHPK3PXP')).toBe(false)
    expect(box.open('JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP')
    expect(box.open('')).toBe('')
  })

  it('refuses a tampered ciphertext', () => {
    withKek()
    const sealed = box.seal('JBSWY3DPEHPK3PXP')
    // 改 IV 里的一个字符 (前缀之后第 6 位, 6 个比特都有效): GCM 认证必然失败
    const i = 'gcm:'.length + 6
    const flipped =
      sealed.slice(0, i) + (sealed[i] === 'A' ? 'B' : 'A') + sealed.slice(i + 1)

    expect(() => box.open(flipped)).toThrow()
  })

  it('refuses to open with another KEK', () => {
    withKek()
    const sealed = box.seal('JBSWY3DPEHPK3PXP')
    withKek('another-kek-that-is-long-enough-0123')

    expect(() => box.open(sealed)).toThrow()
  })

  it('names the missing variable when the KEK is not configured', () => {
    vi.stubEnv(KEK_ENV, '')

    expect(() => box.seal('x')).toThrow(KEK_ENV)
    expect(() => box.open('gcm:AAAA')).toThrow(KEK_ENV)
  })
})

describe('OIDC client_secret', () => {
  // 由抽出 secretBox 之前的 lib/oidc/secret.ts 生成: 库里的存量密文必须原样解得开
  it('opens a ciphertext written by the previous implementation', () => {
    vi.stubEnv('OIDC_SECRET_ENC_KEY', 'kun-secret-box-fixture-kek-0123456789')

    expect(
      decryptClientSecret(
        'gcm:4yL6NWgu2t9gXYQtuerR43sU2Nir83vZYw06BlmV0Vbq8zNezKFhCmxjLAZkyJb-'
      )
    ).toBe('legacy-client-secret')
  })

  it('round-trips through the thin wrapper', () => {
    vi.stubEnv('OIDC_SECRET_ENC_KEY', 'kun-secret-box-fixture-kek-0123456789')
    const sealed = encryptClientSecret('client-secret')

    expect(isEncryptedClientSecret(sealed)).toBe(true)
    expect(decryptClientSecret(sealed)).toBe('client-secret')
    expect(decryptClientSecret('legacy-plaintext')).toBe('legacy-plaintext')
  })
})
