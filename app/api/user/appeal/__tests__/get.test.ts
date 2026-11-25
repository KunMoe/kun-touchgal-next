import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  findTasksMock,
  countTasksMock,
  groupTasksMock,
  findCommentsMock,
  findRatingsMock,
  findResourcesMock,
  queryRawMock
} = vi.hoisted(() => ({
  findTasksMock: vi.fn(),
  countTasksMock: vi.fn(),
  groupTasksMock: vi.fn(),
  findCommentsMock: vi.fn(),
  findRatingsMock: vi.fn(),
  findResourcesMock: vi.fn(),
  queryRawMock: vi.fn()
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
    patch_resource: { findMany: findResourcesMock },
    $queryRaw: queryRawMock
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
    const { appeals } = await getUserAppeals(7, {
      page: 1,
      limit: 10,
      state: 'all'
    })

    expect(appeals[0].state).toBe('appealable')
    expect(appeals[0].original).toEqual({ name: '标题', note: '介绍', links })
  })

  it('AI 翻译补丁的原内容带上模型型号, 其余类型不带', async () => {
    const plain = await getUserAppeals(7, { page: 1, limit: 10, state: 'all' })
    expect(plain.appeals[0].original?.modelName).toBeUndefined()

    const [resource] = await findResourcesMock()
    findResourcesMock.mockResolvedValue([
      { ...resource, type: ['manual', 'ai'], model_name: 'DeepSeek-V3' }
    ])
    const ai = await getUserAppeals(7, { page: 1, limit: 10, state: 'all' })
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
    await getUserAppeals(7, { page: 1, limit: 10, state: 'all' })

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

describe('getUserAppeals 状态筛选', () => {
  const whereOf = async (
    state: Parameters<typeof getUserAppeals>[1]['state']
  ) => {
    await getUserAppeals(7, { page: 1, limit: 10, state })
    const where = findTasksMock.mock.calls[0][0].where
    // 列表与总数必须用同一个条件, 否则页数对不上
    expect(countTasksMock.mock.calls[0][0].where).toEqual(where)
    return where
  }

  it('全部: 不加状态条件, 也不查可申诉任务', async () => {
    const where = await whereOf('all')

    expect(where).not.toHaveProperty('id')
    expect(where).not.toHaveProperty('appeal')
    expect(queryRawMock).not.toHaveBeenCalled()
  })

  it('可申诉: 只取该用户的可申诉任务', async () => {
    queryRawMock.mockResolvedValue([{ id: 3 }, { id: 9 }])
    const where = await whereOf('appealable')

    expect(where).toMatchObject({ user_id: 7, id: { in: [3, 9] } })
    // 按 Prisma 的规则拼回: 绑定参数只有用户 id (状态码以字面量内联)
    const [strings, ...values] = queryRawMock.mock.calls[0]
    expect(new Prisma.Sql(strings, values).values).toEqual([7])
  })

  it('已失效: 未申诉的任务里排除可申诉的', async () => {
    queryRawMock.mockResolvedValue([{ id: 3 }])
    const where = await whereOf('unavailable')

    expect(where).toMatchObject({ appeal: null, id: { notIn: [3] } })
  })

  it.each(['pending', 'approved', 'rejected'] as const)(
    '%s: 按申诉记录的状态筛选',
    async (state) => {
      const where = await whereOf(state)

      expect(where.appeal).toEqual({ status: state })
      expect(where).not.toHaveProperty('id')
      expect(queryRawMock).not.toHaveBeenCalled()
    }
  )
})
