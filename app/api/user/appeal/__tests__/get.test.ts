import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findTasksMock,
  countTasksMock,
  groupTasksMock,
  findCommentsMock,
  findRatingsMock,
  findResourcesMock
} = vi.hoisted(() => ({
  findTasksMock: vi.fn(),
  countTasksMock: vi.fn(),
  groupTasksMock: vi.fn(),
  findCommentsMock: vi.fn(),
  findRatingsMock: vi.fn(),
  findResourcesMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    moderation_task: {
      findMany: findTasksMock,
      count: countTasksMock,
      groupBy: groupTasksMock
    },
    patch_comment: { findMany: findCommentsMock },
    patch_rating: { findMany: findRatingsMock },
    patch_resource: { findMany: findResourcesMock }
  }
}))

import { getUserAppeals } from '~/app/api/user/appeal/get'

const links = [
  {
    id: 21,
    storage: 's3',
    content: 'https://s3.example/patch/1/file.zip',
    size: '700 MB',
    code: '',
    password: 'pw'
  },
  {
    id: 22,
    storage: 'user',
    content: 'https://pan.example/s/abc',
    size: '2 GB',
    code: 'c0de',
    password: ''
  }
]

beforeEach(() => {
  vi.resetAllMocks()
  findTasksMock.mockResolvedValue([
    {
      id: 3,
      content_type: 'resource',
      content_id: 5,
      reject_code: 'AD',
      reviewed: null,
      appeal: null
    }
  ])
  countTasksMock.mockResolvedValue(1)
  groupTasksMock.mockResolvedValue([{ _max: { id: 3 } }])
  findCommentsMock.mockResolvedValue([])
  findRatingsMock.mockResolvedValue([])
  findResourcesMock.mockResolvedValue([
    {
      id: 5,
      name: '标题',
      note: '介绍',
      type: ['manual'],
      model_name: '',
      status: 1,
      links,
      patch: { name: '游戏' }
    }
  ])
})

describe('getUserAppeals 资源链接', () => {
  it('可申诉资源的原内容带上各条链接, 供申诉表单预填', async () => {
    const { appeals } = await getUserAppeals(7, { page: 1, limit: 10 })

    expect(appeals[0].state).toBe('appealable')
    expect(appeals[0].original).toEqual({ name: '标题', note: '介绍', links })
  })

  it('AI 翻译补丁的原内容带上模型型号, 其余类型不带', async () => {
    const plain = await getUserAppeals(7, { page: 1, limit: 10 })
    expect(plain.appeals[0].original?.modelName).toBeUndefined()

    const [resource] = await findResourcesMock()
    findResourcesMock.mockResolvedValue([
      { ...resource, type: ['manual', 'ai'], model_name: 'DeepSeek-V3' }
    ])
    const ai = await getUserAppeals(7, { page: 1, limit: 10 })
    expect(ai.appeals[0].original).toEqual({
      name: '标题',
      note: '介绍',
      modelName: 'DeepSeek-V3',
      links
    })
    expect(findResourcesMock.mock.calls.at(-1)?.[0].select).toMatchObject({
      type: true,
      model_name: true
    })
  })

  it('链接按展示顺序读取, 只取申诉用到的列', async () => {
    await getUserAppeals(7, { page: 1, limit: 10 })

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
