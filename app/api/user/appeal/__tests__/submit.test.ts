import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findTaskMock,
  findNewerTaskMock,
  findOtherAppealMock,
  findResourceMock,
  findCommentMock,
  transactionMock,
  txQueryRawMock,
  txFindResourceMock,
  txLinkFindManyMock,
  createAppealMock,
  renderForWriteMock
} = vi.hoisted(() => ({
  findTaskMock: vi.fn(),
  findNewerTaskMock: vi.fn(),
  findOtherAppealMock: vi.fn(),
  findResourceMock: vi.fn(),
  findCommentMock: vi.fn(),
  transactionMock: vi.fn(),
  txQueryRawMock: vi.fn(),
  txFindResourceMock: vi.fn(),
  txLinkFindManyMock: vi.fn(),
  createAppealMock: vi.fn(),
  renderForWriteMock: vi.fn()
}))

const transactionClient = {
  $queryRaw: txQueryRawMock,
  patch_resource: { findUniqueOrThrow: txFindResourceMock },
  patch_resource_link: { findMany: txLinkFindManyMock },
  moderation_appeal: { create: createAppealMock }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    moderation_task: {
      findUnique: findTaskMock,
      findFirst: findNewerTaskMock
    },
    moderation_appeal: { findFirst: findOtherAppealMock },
    patch_resource: { findUnique: findResourceMock },
    patch_comment: { findUnique: findCommentMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/utils/render/renderKunMarkdown', () => ({
  renderKunMarkdownForWrite: renderForWriteMock
}))

import { submitAppeal } from '~/app/api/user/appeal/submit'

const UID = 7
const RESOURCE_ID = 5

const resourceTask = {
  id: 3,
  user_id: UID,
  status: 'rejected',
  dry_run: false,
  content_id: RESOURCE_ID,
  content_type: 'resource',
  appeal: null
}

// 库中的两条链接行, 按 sort_order: 先站内存储, 后自定义链接
const storedLinks = [
  {
    id: 21,
    storage: 's3',
    content: 'https://s3.example/patch/1/file.zip',
    size: '1 MB',
    code: 'old-c',
    password: 'old-p'
  },
  {
    id: 22,
    storage: 'user',
    content: 'https://pan.example/s/old',
    size: '9 GB',
    code: '',
    password: ''
  }
]

const submittedLink = (id: number, overrides: Record<string, string> = {}) => ({
  id,
  content: 'https://pan.example/s/new',
  size: '2 GB',
  code: 'c0de',
  password: 'pw',
  ...overrides
})

type SubmittedLink = Partial<ReturnType<typeof submittedLink>> & { id: number }

const resourceInput = (links: SubmittedLink[], modelName?: string) => ({
  contentType: 'resource' as const,
  taskId: 3,
  name: '新标题',
  note: '新介绍',
  modelName,
  links
})

const createdPayload = () => createAppealMock.mock.calls[0][0].data.payload

beforeEach(() => {
  vi.resetAllMocks()
  findTaskMock.mockResolvedValue(resourceTask)
  findNewerTaskMock.mockResolvedValue(null)
  findOtherAppealMock.mockResolvedValue(null)
  findResourceMock.mockResolvedValue({ user_id: UID, status: 1 })
  findCommentMock.mockResolvedValue({ user_id: UID, status: 2 })
  txQueryRawMock.mockResolvedValue([{ id: RESOURCE_ID }])
  txFindResourceMock.mockResolvedValue({ type: ['manual'], model_name: '' })
  txLinkFindManyMock.mockResolvedValue(storedLinks)
  createAppealMock.mockResolvedValue({})
  renderForWriteMock.mockResolvedValue({ html: '<p>ok</p>', version: 1 })
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('submitAppeal 资源链接', () => {
  it('把各条链接可改的字段写进申诉载荷, 顺序与存储类型以库中的行为准', async () => {
    const result = await submitAppeal(
      // 提交顺序与库中相反, 且不带 storage
      resourceInput([
        submittedLink(22),
        submittedLink(21, { size: '700 MB', code: '', password: '' })
      ]),
      UID
    )

    expect(result).toEqual({})
    expect(txLinkFindManyMock).toHaveBeenCalledWith({
      where: { resource_id: RESOURCE_ID },
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
    expect(createdPayload()).toEqual({
      name: '新标题',
      note: '新介绍',
      links: [
        {
          id: 21,
          storage: 's3',
          content: 'https://s3.example/patch/1/file.zip',
          size: '700 MB',
          code: '',
          password: ''
        },
        {
          id: 22,
          storage: 'user',
          content: 'https://pan.example/s/new',
          size: '2 GB',
          code: 'c0de',
          password: 'pw'
        }
      ]
    })
  })

  it('站内存储的链接地址不取提交值', async () => {
    await submitAppeal(
      resourceInput([
        submittedLink(21, { content: 'https://evil.example/ad' }),
        submittedLink(22)
      ]),
      UID
    )

    expect(createdPayload().links[0].content).toBe(
      'https://s3.example/patch/1/file.zip'
    )
  })

  // TouchGal 资源盘的链接只有超级管理员能写 (资源发布 / 编辑路由), 申诉不得绕过
  it('TouchGal 资源盘的链接整条保留库中的值', async () => {
    const official = {
      id: 22,
      storage: 'touchgal',
      content: 'https://pan.touchgal.net/s/official',
      size: '9 GB',
      code: 'keep',
      password: 'keep-pw'
    }
    txLinkFindManyMock.mockResolvedValue([storedLinks[0], official])

    const result = await submitAppeal(
      resourceInput([
        submittedLink(21),
        submittedLink(22, { content: 'https://evil.example/ad' })
      ]),
      UID
    )

    expect(result).toEqual({})
    expect(createdPayload().links[1]).toEqual(official)
  })

  it('TouchGal 资源盘的链接提交空地址不算错', async () => {
    txLinkFindManyMock.mockResolvedValue([
      storedLinks[0],
      { ...storedLinks[1], storage: 'touchgal' }
    ])

    const result = await submitAppeal(
      resourceInput([submittedLink(21), submittedLink(22, { content: '' })]),
      UID
    )

    expect(result).toEqual({})
    expect(createdPayload().links[1].content).toBe('https://pan.example/s/old')
  })

  // 申诉页每条链接只提交作者可改的字段; 不可改的字段不提交、不校验, 库里不合现行
  // 格式的旧值不会卡住申诉
  it('不可改的字段可以不提交, 一律保留库中的值', async () => {
    const official = {
      id: 22,
      storage: 'touchgal',
      content: '',
      size: '未知',
      code: 'keep',
      password: ''
    }
    txLinkFindManyMock.mockResolvedValue([
      { ...storedLinks[0], content: '' },
      official
    ])

    const result = await submitAppeal(
      resourceInput([
        { id: 21, size: '700 MB', code: '', password: 'pw' },
        { id: 22 }
      ]),
      UID
    )

    expect(result).toEqual({})
    expect(createdPayload().links).toEqual([
      {
        id: 21,
        storage: 's3',
        content: '',
        size: '700 MB',
        code: '',
        password: 'pw'
      },
      official
    ])
  })

  it.each(['content', 'size', 'code', 'password'] as const)(
    '可改的字段 %s 没有提交时拒绝',
    async (field) => {
      const { [field]: _omitted, ...rest } = submittedLink(22)

      const result = await submitAppeal(
        resourceInput([submittedLink(21), rest]),
        UID
      )

      expect(result).toBe('资源链接已变更, 请刷新后重试')
      expect(createAppealMock).not.toHaveBeenCalled()
    }
  )

  it('链接行在资源行锁之后读取', async () => {
    await submitAppeal(
      resourceInput([submittedLink(21), submittedLink(22)]),
      UID
    )

    expect(txQueryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      txLinkFindManyMock.mock.invocationCallOrder[0]
    )
  })

  it.each([
    ['少一条', [submittedLink(21)]],
    ['多一条', [submittedLink(21), submittedLink(22), submittedLink(23)]],
    ['换了一条', [submittedLink(21), submittedLink(30)]],
    ['同一条提交两次', [submittedLink(21), submittedLink(21)]]
  ])('提交的链接与库中的行对不上 (%s) 时拒绝', async (_, links) => {
    const result = await submitAppeal(resourceInput(links), UID)

    expect(result).toBe('资源链接已变更, 请刷新后重试')
    expect(createAppealMock).not.toHaveBeenCalled()
  })

  it('自定义链接的地址不可为空白', async () => {
    const result = await submitAppeal(
      resourceInput([submittedLink(21), submittedLink(22, { content: '  ' })]),
      UID
    )

    expect(result).toBe('请输入资源链接')
    expect(createAppealMock).not.toHaveBeenCalled()
  })

  // 与发布 / 编辑同一条规则 (storageGate.ts): 外链不许指向本站桶里的对象
  describe('自定义链接的地址指向本站桶里的对象', () => {
    const BUCKET = 'https://bucket.example'
    const OBJECT_URL = `${BUCKET}/patch/1/resource/abc/file.zip`
    const MANAGED_ERROR =
      '本站对象存储里的文件不能填成外部链接, 请选择「对象存储」并上传文件'

    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_KUN_VISUAL_NOVEL_S3_STORAGE_URL', BUCKET)
    })

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('申诉里把地址改成桶里的对象: 拒绝, 不建申诉', async () => {
      const result = await submitAppeal(
        resourceInput([
          submittedLink(21),
          submittedLink(22, { content: OBJECT_URL })
        ]),
        UID
      )

      expect(result).toBe(MANAGED_ERROR)
      expect(createAppealMock).not.toHaveBeenCalled()
    })

    it('库里本来就是这样的地址、申诉没有改它: 不判', async () => {
      txLinkFindManyMock.mockResolvedValue([
        storedLinks[0],
        { ...storedLinks[1], content: OBJECT_URL }
      ])

      const result = await submitAppeal(
        resourceInput([
          submittedLink(21),
          submittedLink(22, { content: OBJECT_URL })
        ]),
        UID
      )

      expect(result).not.toBe(MANAGED_ERROR)
      expect(createAppealMock).toHaveBeenCalledTimes(1)
    })
  })

  it('站内存储的链接提交空地址不算错', async () => {
    const result = await submitAppeal(
      resourceInput([submittedLink(21, { content: '' }), submittedLink(22)]),
      UID
    )

    expect(result).toEqual({})
    expect(createAppealMock).toHaveBeenCalledTimes(1)
  })

  it('资源已不在可申诉的隐藏态时不读链接', async () => {
    txQueryRawMock.mockResolvedValue([])

    const result = await submitAppeal(
      resourceInput([submittedLink(21), submittedLink(22)]),
      UID
    )

    expect(result).toBe('内容不存在或状态已变更, 无法申诉')
    expect(txLinkFindManyMock).not.toHaveBeenCalled()
    expect(createAppealMock).not.toHaveBeenCalled()
  })
})

describe('submitAppeal 模型型号', () => {
  const links = [submittedLink(21), submittedLink(22)]

  beforeEach(() => {
    txFindResourceMock.mockResolvedValue({
      type: ['manual', 'ai'],
      model_name: 'GPT-旧'
    })
  })

  it('AI 翻译补丁: 提交的模型型号写进申诉载荷', async () => {
    const result = await submitAppeal(resourceInput(links, 'DeepSeek-V3'), UID)

    expect(result).toEqual({})
    expect(createdPayload()).toMatchObject({
      name: '新标题',
      note: '新介绍',
      modelName: 'DeepSeek-V3'
    })
  })

  // 与发布 / 编辑资源的规则一致: AI 翻译补丁必须填写模型型号
  it.each([
    ['没有提交', undefined],
    ['提交了空串', '']
  ])('AI 翻译补丁: 模型型号%s时拒绝', async (_, modelName) => {
    const result = await submitAppeal(resourceInput(links, modelName), UID)

    expect(result).toBe('请填写模型型号')
    expect(createAppealMock).not.toHaveBeenCalled()
  })

  it('其余类型的资源没有模型型号: 提交了也不取', async () => {
    txFindResourceMock.mockResolvedValue({ type: ['manual'], model_name: '' })

    const result = await submitAppeal(resourceInput(links, '夹带的文字'), UID)

    expect(result).toEqual({})
    expect(createdPayload().modelName).toBeUndefined()
    // 写进 jsonb 的内容里没有这个键
    expect(JSON.parse(JSON.stringify(createdPayload()))).not.toHaveProperty(
      'modelName'
    )
  })

  it('资源的类型在资源行锁之后读取', async () => {
    await submitAppeal(resourceInput(links, 'DeepSeek-V3'), UID)

    expect(txFindResourceMock).toHaveBeenCalledWith({
      where: { id: RESOURCE_ID },
      select: { type: true, model_name: true }
    })
    expect(txQueryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      txFindResourceMock.mock.invocationCallOrder[0]
    )
  })
})

describe('submitAppeal 评论', () => {
  it('载荷只有正文, 不涉及链接', async () => {
    findTaskMock.mockResolvedValue({
      ...resourceTask,
      content_type: 'comment'
    })

    const result = await submitAppeal(
      { contentType: 'comment', taskId: 3, content: '改过的评论' },
      UID
    )

    expect(result).toEqual({})
    expect(createdPayload()).toEqual({ text: '改过的评论' })
    expect(txFindResourceMock).not.toHaveBeenCalled()
    expect(txLinkFindManyMock).not.toHaveBeenCalled()
  })
})

// 申诉通过时载荷里的正文原样写回评论 / 资源备注, 渲染不出来的内容要在提交时拒绝:
// 留到管理员通过时才发现, 用户已经改不了了 (申诉只能提交一次)
describe('submitAppeal 渲染不出来的正文', () => {
  it('评论申诉按评论管线检查, 被拒时不建申诉', async () => {
    findTaskMock.mockResolvedValue({
      ...resourceTask,
      content_type: 'comment'
    })
    renderForWriteMock.mockResolvedValue(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )

    const result = await submitAppeal(
      { contentType: 'comment', taskId: 3, content: '> > > 评论' },
      UID
    )

    expect(result).toBe(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )
    expect(renderForWriteMock).toHaveBeenCalledWith('comment', '> > > 评论')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('资源申诉按备注管线检查介绍, 被拒时不建申诉', async () => {
    renderForWriteMock.mockResolvedValue(
      '资源备注中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )

    const result = await submitAppeal(resourceInput([]), UID)

    expect(result).toBe(
      '资源备注中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )
    expect(renderForWriteMock).toHaveBeenCalledWith('note', '新介绍')
    expect(transactionMock).not.toHaveBeenCalled()
  })
})

// 载荷是 jsonb: Prisma 先 JSON.stringify, 孤立代理被写成 "\ud800" 转义, PG 解析时拒收,
// 整个事务失败。JSON 请求体里的 \u 转义能带进孤立代理, 所以在写入处替换成 U+FFFD,
// 与写 varchar 时驱动的做法一致
describe('submitAppeal 载荷里的孤立代理', () => {
  const noLoneSurrogateEscape = (value: unknown) =>
    expect(JSON.stringify(value)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i)

  it('评论正文', async () => {
    findTaskMock.mockResolvedValue({ ...resourceTask, content_type: 'comment' })

    await submitAppeal(
      { contentType: 'comment', taskId: 3, content: '改过\ud800的评论😀' },
      UID
    )

    expect(createdPayload()).toEqual({ text: '改过�的评论😀' })
    noLoneSurrogateEscape(createdPayload())
  })

  it('资源标题与链接字段', async () => {
    await submitAppeal(
      {
        ...resourceInput([
          submittedLink(21),
          submittedLink(22, { code: 'c\udc00' })
        ]),
        name: '标题\udbff'
      },
      UID
    )

    expect(createdPayload().name).toBe('标题�')
    expect(createdPayload().links[1].code).toBe('c�')
    noLoneSurrogateEscape(createdPayload())
  })
})
