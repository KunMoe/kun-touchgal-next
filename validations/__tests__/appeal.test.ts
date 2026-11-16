import { describe, expect, it } from 'vitest'
import { getUserAppealSchema, submitAppealSchema } from '~/validations/appeal'

const link = {
  id: 21,
  content: 'https://pan.example/s/abc',
  size: '1.5 GB',
  code: '',
  password: ''
}

const resourceAppeal = (links: unknown) => ({
  contentType: 'resource',
  taskId: 3,
  name: '标题',
  note: '介绍',
  links
})

const issuePaths = (input: unknown) => {
  const result = submitAppealSchema.safeParse(input)
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join('.'))
}

describe('submitAppealSchema 资源链接', () => {
  it('接受链接、大小、提取码、解压码, 并丢弃其余键', () => {
    const result = submitAppealSchema.safeParse(
      resourceAppeal([
        { ...link, code: ' c0de ', password: 'pw', storage: 's3', hash: 'x' }
      ])
    )

    expect(result.success).toBe(true)
    // 提取码沿用发布资源时的 trim; storage / hash 不是申诉可提交的字段
    expect(result.data).toMatchObject({
      links: [{ ...link, code: 'c0de', password: 'pw' }]
    })
    expect(result.data).not.toHaveProperty('links.0.storage')
    expect(result.data).not.toHaveProperty('links.0.hash')
  })

  // 发布前就打开着的旧申诉页不带 links: 给出能照着做的提示, 而不是默认的类型错误
  it('资源申诉必须带上链接, 缺失时提示刷新', () => {
    const result = submitAppealSchema.safeParse(resourceAppeal(undefined))

    expect(result.success).toBe(false)
    expect(result.error?.issues).toMatchObject([
      { path: ['links'], message: '申诉页面已更新, 请刷新后重试' }
    ])
  })

  // 每条链接只提交作者可改的字段, 哪些必须带由服务端对着库中的行判断
  it('四个字段都可以不带', () => {
    expect(issuePaths(resourceAppeal([{ id: 21 }]))).toEqual([])
  })

  // 各字段的约束与发布 / 编辑资源用的是同一份 schema
  it.each([
    ['大小不以 MB / GB 结尾', { size: '1.5' }, 'links.0.size'],
    ['链接超过 1007 个字符', { content: 'a'.repeat(1008) }, 'links.0.content'],
    ['提取码超过 1007 位', { code: 'a'.repeat(1008) }, 'links.0.code'],
    ['解压码超过 1007 位', { password: 'a'.repeat(1008) }, 'links.0.password'],
    ['缺少链接 id', { id: undefined }, 'links.0.id']
  ])('%s 时校验失败', (_, overrides, path) => {
    expect(issuePaths(resourceAppeal([{ ...link, ...overrides }]))).toEqual([
      path
    ])
  })

  it('链接条数不超过发布时的上限', () => {
    const links = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...link, id: index + 1 }))

    expect(issuePaths(resourceAppeal(links(10)))).toEqual([])
    expect(issuePaths(resourceAppeal(links(11)))).toEqual(['links'])
  })
})

describe('submitAppealSchema 模型型号', () => {
  const parse = (modelName: unknown) =>
    submitAppealSchema.safeParse({ ...resourceAppeal([link]), modelName })

  // 只有 AI 翻译补丁有这个字段, 是否必填由服务端对着库中的资源判断
  it('可以不带', () => {
    expect(issuePaths(resourceAppeal([link]))).toEqual([])
  })

  it('约束与发布资源时相同: 去首尾空白, 最多 107 个字符', () => {
    expect(parse('  DeepSeek-V3 ').data).toMatchObject({
      modelName: 'DeepSeek-V3'
    })
    expect(parse('a'.repeat(107)).success).toBe(true)
    expect(parse('a'.repeat(108)).error?.issues).toMatchObject([
      { path: ['modelName'], message: '模型型号最多 107 个字符' }
    ])
    expect(parse(42).error?.issues).toMatchObject([
      { path: ['modelName'], message: '模型型号格式不正确' }
    ])
  })
})

describe('submitAppealSchema 评论与评价', () => {
  it('不受链接字段影响', () => {
    expect(
      issuePaths({ contentType: 'comment', taskId: 3, content: '评论' })
    ).toEqual([])
    expect(
      issuePaths({ contentType: 'rating', taskId: 3, shortSummary: '评价' })
    ).toEqual([])
  })
})

describe('getUserAppealSchema 状态筛选', () => {
  it('不带状态时只取可申诉的内容', () => {
    const result = getUserAppealSchema.safeParse({ page: '1', limit: '10' })

    expect(result.success && result.data.state).toBe('appealable')
  })

  it('接受全部与各个申诉状态, 拒绝其余值', () => {
    for (const state of [
      'all',
      'appealable',
      'pending',
      'approved',
      'rejected',
      'unavailable'
    ]) {
      expect(
        getUserAppealSchema.safeParse({ page: 1, limit: 10, state }).success
      ).toBe(true)
    }
    expect(
      getUserAppealSchema.safeParse({ page: 1, limit: 10, state: 'manual' })
        .success
    ).toBe(false)
  })
})
