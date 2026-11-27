import { describe, expect, it } from 'vitest'
import {
  patchResourceCreateSchema,
  patchResourceUpdateSchema,
  togglePatchFavoriteSchema
} from '~/validations/patch'

const baseInput = {
  patchId: 1,
  section: 'patch',
  name: '测试资源',
  note: '',
  links: [
    {
      storage: 'user',
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

  it('三条联动各自的路径、文案与先后', () => {
    const result = patchResourceCreateSchema.safeParse({
      ...baseInput,
      section: 'galgame',
      type: ['ai'],
      platform: ['emulator']
    })
    expect(
      result.success
        ? []
        : result.error.issues.map((issue) => [
            issue.path.join('.'),
            issue.message
          ])
    ).toEqual([
      ['type', '所选资源类型不属于当前资源类别'],
      ['emulatorType', '选择模拟器平台时请选择模拟器类型'],
      ['modelName', '发布 AI 翻译补丁时请填写模型型号']
    ])
  })

  // 联动改由判据给出之后, 这几类输入的报错要与此前一条不多、一条不少: 判据另外报的
  // 词表外的值、空数组与孤儿值, 校验不重复报
  it.each<[string, Record<string, unknown>, string[][]]>([
    [
      '旧类型值',
      { section: 'galgame', type: ['pc', 'chinese', 'game'] },
      [
        ['custom', 'type', '非法的类型'],
        ['custom', 'type', '所选资源类型不属于当前资源类别']
      ]
    ],
    [
      '类型为空',
      { type: [] },
      [['too_small', 'type', '请选择至少一个资源类型']]
    ],
    [
      '语言与平台为空',
      { language: [], platform: [] },
      [
        ['too_small', 'language', '请选择至少一个资源语言'],
        ['too_small', 'platform', '请选择至少一个资源平台']
      ]
    ],
    [
      '模拟器平台配已删除的模拟器类型',
      { platform: ['emulator'], emulatorType: ['winlator'] },
      [['custom', 'emulatorType', '非法的模拟器类型']]
    ],
    [
      '不该有的模拟器类型与模型型号 (落库前清掉)',
      { emulatorType: ['joiplay'], modelName: 'GPT-4o' },
      []
    ],
    [
      '词表外的类别同时触发两条条件必填',
      { section: 'constructor', type: ['ai'], platform: ['emulator'] },
      [
        ['custom', 'section', '资源链接类型仅能为 Galgame 或补丁'],
        ['custom', 'emulatorType', '选择模拟器平台时请选择模拟器类型'],
        ['custom', 'modelName', '发布 AI 翻译补丁时请填写模型型号']
      ]
    ]
  ])('完整的报错列表: %s', (_, fields, expected) => {
    const result = patchResourceCreateSchema.safeParse({
      ...baseInput,
      ...fields
    })
    expect(
      result.success
        ? []
        : result.error.issues.map((issue) => [
            issue.code,
            issue.path.join('.'),
            issue.message
          ])
    ).toEqual(expected)
  })

  // 拿 section 直接查对象字面量会命中原型链上的成员, 此前校验在这里抛 TypeError (接口回 500)
  it.each(['constructor', '__proto__', 'toString'])(
    '资源类别取对象原型上的成员名 %s 时回业务错误',
    (section) => {
      const result = patchResourceUpdateSchema.safeParse({
        ...baseInput,
        resourceId: 1,
        section
      })
      expect(
        result.success ? [] : result.error.issues.map((issue) => issue.message)
      ).toEqual(['资源链接类型仅能为 Galgame 或补丁'])
    }
  )
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

// 链接按存储类型分成两种形态, 各自只收属于自己的字段 (T45)。此前是一个扁平对象, hash 在请求里
// 装上传 token、在库里是历史对象的校验码, 服务端只能靠「与库里的值是否相同」猜它是哪一种
describe('资源链接按存储类型判别', () => {
  const parseLinks = (links: Array<Record<string, unknown>>) =>
    patchResourceUpdateSchema.safeParse({ ...baseInput, resourceId: 9, links })
  const issuesOf = (links: Array<Record<string, unknown>>) => {
    const result = parseLinks(links)
    return result.success
      ? []
      : result.error.issues.map((issue) => [
          issue.path.join('.'),
          issue.message
        ])
  }
  const parsedLink = (link: Record<string, unknown>) => {
    const result = parseLinks([link])
    if (!result.success) {
      throw new Error(JSON.stringify(result.error.issues))
    }
    return result.data.links[0]
  }
  const s3 = { storage: 's3', code: '', password: '' }
  const [external] = baseInput.links

  it('对象存储: 新上传带 uploadToken, 沿用原文件只带 id', () => {
    expect(parsedLink({ ...s3, uploadToken: 'tok' })).toEqual({
      ...s3,
      uploadToken: 'tok'
    })
    expect(parsedLink({ ...s3, id: 5 })).toEqual({ ...s3, id: 5 })
    expect(parsedLink({ ...s3, id: 5, uploadToken: 'tok' })).toEqual({
      ...s3,
      id: 5,
      uploadToken: 'tok'
    })
  })

  // 上传 token 是 24 字节的 base64url (server/storage/stagedUpload.ts), 32 个字符
  it('真实长度的上传 token 过得了长度上限', () => {
    const token = 'q83vEjRWeJBqrCfx9Mz0tQ8k2LmN4pYa'
    expect(token).toHaveLength(32)
    expect(parsedLink({ ...s3, uploadToken: token })).toMatchObject({
      uploadToken: token
    })
    expect(issuesOf([{ ...s3, uploadToken: 'x'.repeat(108) }])).toEqual([
      ['links.0.uploadToken', '上传凭证不正确, 请重新上传文件']
    ])
  })

  it('对象存储链接的提取码与解压码沿用同一份约束', () => {
    expect(parsedLink({ ...s3, id: 5, code: ' c0de ' })).toMatchObject({
      code: 'c0de'
    })
    expect(issuesOf([{ ...s3, id: 5, code: 'x'.repeat(1008) }])).toEqual([
      ['links.0.code', '资源提取码长度最多 1007 位']
    ])
    expect(issuesOf([{ ...s3, id: 5, password: 'x'.repeat(1008) }])).toEqual([
      ['links.0.password', '资源解压码长度最多 1007 位']
    ])
  })

  it.each([
    ['既没有 id 也没有 uploadToken', {}],
    ['uploadToken 是空串', { uploadToken: '' }],
    ['uploadToken 只有空白', { uploadToken: '   ' }]
  ])('对象存储%s: 请先上传', (_label, fields) => {
    expect(issuesOf([{ ...s3, ...fields }])).toEqual([
      ['links.0.uploadToken', '请先上传资源文件']
    ])
  })

  it('对象存储的地址与大小归服务端: 请求里带了也不取', () => {
    expect(
      parsedLink({
        ...s3,
        id: 5,
        content: 'https://evil.example/file.zip',
        size: '999 GB',
        s3_key: 'patch/1/resource/x/y.zip'
      })
    ).toEqual({ ...s3, id: 5 })
  })

  // 过渡守卫: 发布前打开的旧页面把上传 token 或库里的校验码放在 hash 里
  it.each([
    ['上传 token', 'q83vEjRWeJBqrCfx9Mz0tQ8k2LmN4pYa'],
    ['库里的 BLAKE3 校验码', 'b3'.repeat(32)]
  ])('旧页面在对象存储链接的 hash 里回传%s: 提示刷新', (_label, hash) => {
    expect(
      issuesOf([{ ...s3, id: 5, hash, content: '', size: '1 MB' }])
    ).toEqual([['links.0.hash', '页面版本已更新, 请刷新后重试']])
  })

  it('旧页面新上传 (token 在 hash 里、没有 id): 只提示刷新, 不再多报一条「请先上传」', () => {
    expect(
      issuesOf([{ ...s3, hash: 'q83vEjRWeJBqrCfx9Mz0tQ8k2LmN4pYa' }])
    ).toEqual([['links.0.hash', '页面版本已更新, 请刷新后重试']])
  })

  it('旧页面沿用新式对象存储链接 (hash 为空) 照常通过', () => {
    expect(
      issuesOf([{ ...s3, id: 5, hash: '', content: 'x', size: '1 MB' }])
    ).toEqual([])
  })

  it('外链: 地址与大小由用户填, 不属于它的 hash / uploadToken 不取', () => {
    expect(
      parsedLink({
        ...external,
        id: 5,
        hash: 'x'.repeat(107),
        uploadToken: 'tok'
      })
    ).toEqual({ ...external, id: 5 })
    expect(parsedLink({ ...external, storage: 'touchgal' })).toEqual({
      ...external,
      storage: 'touchgal'
    })
  })

  it.each([
    ['空串', ''],
    ['只有空白', '   ']
  ])('外链的地址是%s: 请输入资源链接', (_label, content) => {
    expect(issuesOf([{ ...external, content }])).toEqual([
      ['links.0.content', '请输入资源链接']
    ])
  })

  it('外链的地址原样落库, 不 trim (与库里的行逐字比较靠它)', () => {
    expect(
      parsedLink({ ...external, content: ' https://example.com/a ' })
    ).toMatchObject({ content: ' https://example.com/a ' })
  })

  it('外链的大小、提取码沿用各字段原来的约束', () => {
    expect(issuesOf([{ ...external, size: '很大' }])).toEqual([
      ['links.0.size', '请选择资源的大小, MB 或 GB']
    ])
    expect(parsedLink({ ...external, code: ' c0de ' })).toMatchObject({
      code: 'c0de'
    })
  })

  it.each([
    ['不认识的存储类型', { ...external, storage: 'ftp' }],
    ['没有存储类型', { content: 'x', size: '1 MB', code: '', password: '' }],
    ['原型上的成员名', { ...external, storage: 'constructor' }]
  ])('%s: 只报这一条', (_label, link) => {
    expect(issuesOf([link])).toEqual([
      ['links.0.storage', '非法的资源链接类型']
    ])
  })

  it('各条链接各自判别, 错误落在各自的下标上', () => {
    expect(issuesOf([external, s3, { ...external, content: '' }])).toEqual([
      ['links.1.uploadToken', '请先上传资源文件'],
      ['links.2.content', '请输入资源链接']
    ])
  })
})

// 收藏切换拿 folderId 拼 advisory lock 的 ::int 参数: 小数进去 PG 报 22P02 (500)
describe('togglePatchFavoriteSchema 的 id 必须是整数', () => {
  it.each([
    [{ patchId: 1, folderId: 1.5 }, '收藏文件夹 ID 无效'],
    [{ patchId: 1.5, folderId: 1 }, '游戏 ID 无效']
  ])('%j 被拒', (input, message) => {
    const result = togglePatchFavoriteSchema.safeParse(input)
    expect(result.success ? '' : result.error.issues[0].message).toBe(message)
  })
})
