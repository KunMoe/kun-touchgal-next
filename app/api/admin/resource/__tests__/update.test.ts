import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)
const { updateByRoleMock } = vi.hoisted(() => ({ updateByRoleMock: vi.fn() }))

vi.mock('~/prisma/index', () => rec.module)
// 资源编辑的主体 (S3 重绑、链接 diff、送审) 由它自己的测试覆盖; 这里只看后台入口
// 怎么调用它、怎么记审计
vi.mock('~/app/api/patch/resource/update', () => ({
  updatePatchResource: updateByRoleMock
}))
vi.mock('~/app/api/patch/resource/_helper', () => ({
  sanitizeResourceLinksForAuditLog: (links: Array<Record<string, unknown>>) =>
    links.map(({ content, password, code, hash, s3_key, ...rest }) => rest)
}))

import { updatePatchResource } from '~/app/api/admin/resource/update'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'

const input = {
  resourceId: 3,
  patchId: 10,
  name: '新名字'
} as unknown as Parameters<typeof updatePatchResource>[0]

const stored = { id: 3, patch_id: 10, user_id: 7, name: '旧名字', status: 0 }
const updated = {
  id: 3,
  name: '新名字',
  status: 0,
  links: [{ id: 21, storage: 's3', content: 'secret-url', password: 'pw' }]
}

const logContent = () =>
  (rec.argsOf('admin_log.create')[0] as { data: { content: string } }).data
    .content

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
  rec.on('user.findUnique', { id: 99, name: 'admin' })
  rec.on('patch_resource.findUnique', stored)
  updateByRoleMock.mockResolvedValue(updated)
})

describe('后台 updatePatchResource', () => {
  it('管理员不存在', async () => {
    rec.on('user.findUnique', null)

    expect(
      await updatePatchResource(input, kunTestActor({ uid: 99, role: 4 }))
    ).toBe('未找到该管理员')
    expect(updateByRoleMock).not.toHaveBeenCalled()
  })

  it('资源不存在', async () => {
    rec.on('patch_resource.findUnique', null)

    expect(
      await updatePatchResource(input, kunTestActor({ uid: 99, role: 4 }))
    ).toBe('未找到该资源')
    expect(updateByRoleMock).not.toHaveBeenCalled()
  })

  // 以前这里写死角色 3: 超级管理员在后台改资源文本会失去送审豁免, 公开资源被打成
  // 待审核, 审核任务挂到原作者名下
  it.each([4, 3] as const)('以操作者的真实角色编辑 (role %i)', async (role) => {
    const actor = kunTestActor({ uid: 99, role })
    await updatePatchResource(input, actor)

    // 交下去的就是调用方给的操作者 (同一对象), 不是入口按固定角色另造的
    expect(updateByRoleMock.mock.calls[0][1]).toBe(actor)
  })

  // 后台表格里隐藏的资源也有「编辑」: 守卫包含隐藏态 (1), 编辑后仍是隐藏
  it('后台可以编辑任何状态的资源, 包括隐藏的', async () => {
    await updatePatchResource(input, kunTestActor({ uid: 99, role: 4 }))

    expect(updateByRoleMock.mock.calls[0][2]).toBe('admin')
  })

  it('编辑用例返回业务错误时原样返回, 不记审计', async () => {
    updateByRoleMock.mockResolvedValue('未找到该资源')

    expect(
      await updatePatchResource(input, kunTestActor({ uid: 99, role: 4 }))
    ).toBe('未找到该资源')
    expect(rec.attempts).toHaveLength(0)
  })

  it('成功后记一条审计: 原资源与脱敏后的新资源', async () => {
    const result = await updatePatchResource(
      input,
      kunTestActor({ uid: 99, role: 4 })
    )

    expect(result).toBe(updated)
    expect(rec.attempts[0].committed).toBe(true)
    expect(rec.labels()).toEqual(['admin_log.create'])
    expect(logContent()).toContain('管理员 admin 更新了一个资源信息')
    expect(logContent()).toContain('"name":"旧名字"')
    expect(logContent()).toContain('"name":"新名字"')
    // 链接里的地址与口令不进审计
    expect(logContent()).not.toContain('secret-url')
    expect(logContent()).not.toContain('"password"')
  })
})
