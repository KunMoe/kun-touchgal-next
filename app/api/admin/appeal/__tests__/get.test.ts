import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findAppealsMock,
  countAppealsMock,
  findCommentsMock,
  findRatingsMock,
  findResourcesMock
} = vi.hoisted(() => ({
  findAppealsMock: vi.fn(),
  countAppealsMock: vi.fn(),
  findCommentsMock: vi.fn(),
  findRatingsMock: vi.fn(),
  findResourcesMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    moderation_appeal: { findMany: findAppealsMock, count: countAppealsMock },
    patch_comment: { findMany: findCommentsMock },
    patch_rating: { findMany: findRatingsMock },
    patch_resource: { findMany: findResourcesMock }
  }
}))

import { getAppeals } from '~/app/api/admin/appeal/get'

const storedLink = {
  id: 22,
  storage: 'user',
  content: 'https://pan.example/s/old',
  size: '2 GB',
  code: 'c0de',
  password: ''
}
const appealedLink = { ...storedLink, content: 'https://pan.example/s/new' }

beforeEach(() => {
  vi.resetAllMocks()
  findAppealsMock.mockResolvedValue([
    {
      id: 1,
      content_type: 'resource',
      content_id: 5,
      status: 'pending',
      payload: {
        name: '新标题',
        note: '新介绍',
        modelName: 'DeepSeek-V3',
        links: [appealedLink]
      },
      user: { id: 7, name: 'u', avatar: '' },
      task: { reject_reason: '推广链接' },
      created: new Date(0),
      updated: new Date(0)
    }
  ])
  countAppealsMock.mockResolvedValue(1)
  findCommentsMock.mockResolvedValue([])
  findRatingsMock.mockResolvedValue([])
  findResourcesMock.mockResolvedValue([
    {
      id: 5,
      name: '标题',
      note: '介绍',
      type: ['manual', 'ai'],
      model_name: 'GPT-旧',
      links: [storedLink],
      patch: { name: '游戏', unique_id: 'abcd1234' }
    }
  ])
})

describe('getAppeals 资源链接', () => {
  // 管理员通过申诉后不再走 AI 复审, 他看到的必须包含将被写回的链接字段
  it('原内容与申诉内容都带上模型型号与链接字段', async () => {
    const { appeals } = await getAppeals({
      page: 1,
      limit: 10,
      status: 'pending'
    })

    expect(appeals[0].original).toEqual({
      name: '标题',
      note: '介绍',
      modelName: 'GPT-旧',
      links: [storedLink]
    })
    expect(appeals[0].payload).toEqual({
      name: '新标题',
      note: '新介绍',
      modelName: 'DeepSeek-V3',
      links: [appealedLink]
    })
    expect(findResourcesMock.mock.calls[0][0].select).toMatchObject({
      type: true,
      model_name: true
    })
    expect(findResourcesMock.mock.calls[0][0].select.links).toEqual({
      orderBy: { sort_order: 'asc' },
      select: {
        id: true,
        storage: true,
        content: true,
        size: true,
        code: true,
        password: true
      }
    })
  })
})
