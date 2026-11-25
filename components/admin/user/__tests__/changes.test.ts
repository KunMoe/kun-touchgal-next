import { describe, expect, it } from 'vitest'
import { kunAdminUserChanges } from '~/components/admin/user/changes'
import type { AdminUser } from '~/types/api/admin'

const baseline: AdminUser = {
  id: 7,
  name: 'kun',
  email: 'kun@example.com',
  enable2FA: false,
  bio: 'hello',
  avatar: '',
  role: 1,
  status: 0,
  dailyImageCount: 51,
  moemoepoint: -5,
  created: '2026-11-25T00:00:00.000Z',
  _count: { patch: 0, patch_resource: 0 }
}

const none = { password: '', resetImageCount: false }

// 合并契约的客户端一半: 请求只带与基线不同的键 (T31)
describe('kunAdminUserChanges', () => {
  it('没有改动时为空', () => {
    expect(kunAdminUserChanges(baseline, { ...baseline }, none)).toEqual({})
  })

  it('只带改了的键, 没改的列 (含越界的计数与负余额) 不出现', () => {
    expect(
      kunAdminUserChanges(baseline, { ...baseline, status: 2 }, none)
    ).toEqual({ status: 2 })
    expect(
      kunAdminUserChanges(
        baseline,
        {
          ...baseline,
          name: 'kun2',
          email: 'b@example.com',
          role: 2,
          bio: 'x'
        },
        none
      )
    ).toEqual({ name: 'kun2', email: 'b@example.com', role: 2, bio: 'x' })
  })

  it('萌萌点填目标值, 请求带相对基线的差值', () => {
    expect(
      kunAdminUserChanges(baseline, { ...baseline, moemoepoint: 200 }, none)
    ).toEqual({ moemoepointDelta: 205 })
  })

  it('只差前后空白不算修改', () => {
    expect(
      kunAdminUserChanges(
        baseline,
        {
          ...baseline,
          name: ' kun ',
          email: 'kun@example.com ',
          bio: 'hello\n'
        },
        { password: '   ', resetImageCount: false }
      )
    ).toEqual({})
  })

  it('清零与新密码', () => {
    expect(
      kunAdminUserChanges(baseline, baseline, {
        password: 'newpass123',
        resetImageCount: true
      })
    ).toEqual({ resetDailyImageCount: true, password: 'newpass123' })
  })
})
