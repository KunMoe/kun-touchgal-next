import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import {
  KUN_SECURITY_STAMP_MODE,
  rejectOnStampMismatch,
  stampValueOf,
  tokenStampOf
} from '~/server/auth/securityStamp'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('安全戳的读法', () => {
  it('库里的 null 记作 0, 有值取毫秒', () => {
    expect(stampValueOf(null)).toBe(0)
    expect(stampValueOf(undefined)).toBe(0)
    expect(stampValueOf(new Date(1234))).toBe(1234)
  })

  it('令牌不带 cs (存量) 或 cs 不是有限数字时记作 0', () => {
    expect(tokenStampOf({})).toBe(0)
    expect(tokenStampOf({ cs: '5' })).toBe(0)
    expect(tokenStampOf({ cs: Number.NaN })).toBe(0)
    expect(tokenStampOf({ cs: 5 })).toBe(5)
  })
})

describe('rejectOnStampMismatch', () => {
  // 上线先跑影子模式; 切强制是单独的一次发布, 那次提交连这条一起改
  it('当前以影子模式发布: 记一行可 grep 的日志, 不拒绝', () => {
    expect(KUN_SECURITY_STAMP_MODE).toBe('shadow')
    expect(rejectOnStampMismatch('site', { uid: 7, tokenStamp: 1 })).toBe(false)
    expect(kunLog).toHaveBeenCalledExactlyOnceWith(
      'auth.security_stamp_mismatch',
      { mode: 'shadow', source: 'site', uid: 7, tokenStamp: 1 }
    )
  })
})
