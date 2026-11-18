import { describe, expect, it } from 'vitest'
import {
  patchResourceCreateSchema,
  patchResourceUpdateSchema
} from '~/validations/patch'

const baseInput = {
  patchId: 1,
  section: 'patch',
  name: '测试资源',
  note: '',
  links: [
    {
      storage: 'user',
      hash: '',
      content: 'https://example.com/file.zip',
      size: '100MB',
      code: '',
      password: ''
    }
  ],
  type: ['manual'],
  language: ['zh-Hans'],
  platform: ['windows'],
  emulatorType: [] as string[],
  modelName: ''
}

const issuePaths = (
  result: ReturnType<typeof patchResourceCreateSchema.safeParse>
) =>
  result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))

describe('patchResourceCreateSchema 模拟器类型 / 模型型号联动', () => {
  it('未选模拟器平台 / AI 补丁时允许两字段为空', () => {
    const result = patchResourceCreateSchema.safeParse(baseInput)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.emulatorType).toEqual([])
      expect(result.data.modelName).toBe('')
    }
  })

  it('平台含模拟器但未选模拟器类型时校验失败', () => {
    const result = patchResourceCreateSchema.safeParse({
      ...baseInput,
      platform: ['windows', 'emulator']
    })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('emulatorType')
  })

  it('平台含模拟器且已选合法模拟器类型时通过', () => {
    const result = patchResourceCreateSchema.safeParse({
      ...baseInput,
      platform: ['emulator'],
      emulatorType: ['joiplay']
    })
    expect(result.success).toBe(true)
  })

  it('平台含模拟器且同时选多个合法模拟器类型时通过', () => {
    const result = patchResourceCreateSchema.safeParse({
      ...baseInput,
      platform: ['emulator'],
      emulatorType: ['krkr', 'joiplay']
    })
    expect(result.success).toBe(true)
  })

  it('非法的模拟器类型被拒绝', () => {
    const result = patchResourceCreateSchema.safeParse({
      ...baseInput,
      platform: ['emulator'],
      emulatorType: ['not-an-emulator']
    })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('emulatorType')
  })

  it('类型含 AI 翻译补丁但模型型号为空白时校验失败', () => {
    const result = patchResourceCreateSchema.safeParse({
      ...baseInput,
      type: ['ai'],
      modelName: '   '
    })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('modelName')
  })

  it('类型含 AI 翻译补丁且填写模型型号时通过并 trim', () => {
    const result = patchResourceCreateSchema.safeParse({
      ...baseInput,
      type: ['ai'],
      modelName: ' DeepSeek-V3 '
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.modelName).toBe('DeepSeek-V3')
    }
  })

  it('update schema 同样应用联动约束', () => {
    const result = patchResourceUpdateSchema.safeParse({
      ...baseInput,
      resourceId: 1,
      platform: ['emulator'],
      type: ['ai']
    })
    expect(result.success).toBe(false)
    const paths = issuePaths(result)
    expect(paths).toContain('emulatorType')
    expect(paths).toContain('modelName')
  })
})

describe('patchResourceCreateSchema 资源类别 / 类型联动', () => {
  it('Galgame 资源类别下选择补丁类型时校验失败', () => {
    const result = patchResourceCreateSchema.safeParse({
      ...baseInput,
      section: 'galgame',
      type: ['manual']
    })
    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('type')
  })

  it('残留的旧词表类型同时触发词表与类别两条校验', () => {
    const result = patchResourceCreateSchema.safeParse({
      ...baseInput,
      section: 'galgame',
      type: ['pc', 'chinese', 'game']
    })
    expect(result.success).toBe(false)
    const messages = result.success
      ? []
      : result.error.issues.map((issue) => issue.message)
    expect(messages).toContain('非法的类型')
    expect(messages).toContain('所选资源类型不属于当前资源类别')
  })
})

// 一条已有的链接只能提交一次。重复提交会让几行共用同一个存储对象 (保留型对象存储链接),
// 或让保留的那一行指向刚被入队删除的对象 (同一个 id 一条换了文件、一条没换)
describe('资源链接的 id 不可重复', () => {
  const DUPLICATE = '同一条资源链接不能重复提交, 请刷新后重试'
  const [link] = baseInput.links
  const messagesOf = (links: Array<Record<string, unknown>>) => {
    const result = patchResourceUpdateSchema.safeParse({
      ...baseInput,
      resourceId: 9,
      links
    })
    return result.success ? [] : result.error.issues.map((i) => i.message)
  }

  it('同一个 id 出现两次时校验失败', () => {
    expect(
      messagesOf([
        { ...link, id: 5 },
        { ...link, id: 5 }
      ])
    ).toEqual([DUPLICATE])
  })

  it('按转成数字之后的 id 判重', () => {
    expect(
      messagesOf([
        { ...link, id: '5' },
        { ...link, id: 5 }
      ])
    ).toEqual([DUPLICATE])
  })

  it('id 各不相同、或都是没有 id 的新链接时通过', () => {
    expect(
      messagesOf([{ ...link, id: 5 }, { ...link, id: 6 }, link, link])
    ).toEqual([])
  })

  it('创建用的 schema 是同一份链接校验', () => {
    const result = patchResourceCreateSchema.safeParse({
      ...baseInput,
      links: [
        { ...link, id: 5 },
        { ...link, id: 5 }
      ]
    })
    expect(result.success).toBe(false)
  })
})
