import { describe, expect, it } from 'vitest'
import {
  RESOURCE_FIELD_POLICY,
  RESOURCE_LINK_FIELD_POLICY,
  bioSubject,
  commentSubject,
  isSubjectEmpty,
  ratingSubject,
  resourceSubject,
  segmentMaxLength,
  subjectChanged,
  submittedLinkSubject
} from '../subject'
import type { ModerationSubject, SubjectSegment } from '../subject'
import { patchResourceCreateSchema } from '~/validations/patch'

const classified = (policy: Record<string, unknown>, kind: string) =>
  Object.entries(policy)
    .filter(([, value]) =>
      kind === 'audit' ? typeof value === 'object' : value === kind
    )
    .map(([key]) => key)

describe('资源字段策略表', () => {
  // 两张表以对外 DTO 的键 satisfies 约束, 漏分类在 typecheck 阶段就失败;
  // 这里锁住的是「哪些字段送审」这个产品决定, 改动必须是有意的
  it('资源本体送审标题、介绍、模型型号', () => {
    expect(classified(RESOURCE_FIELD_POLICY, 'audit')).toEqual([
      'name',
      'note',
      'modelName'
    ])
    expect(RESOURCE_FIELD_POLICY.name).toMatchObject({
      audit: 'plain',
      label: '标题'
    })
    expect(RESOURCE_FIELD_POLICY.note).toMatchObject({
      audit: 'markdown-standard',
      label: '介绍'
    })
    expect(RESOURCE_FIELD_POLICY.modelName).toMatchObject({
      audit: 'plain',
      label: '模型型号'
    })
  })

  // 上限读自写入校验的 Zod schema; 这里写死数字是为了让 schema 的改动在此显形
  it('每个送审字段的长度上限与写入校验一致', () => {
    expect(segmentMaxLength('comment', '评论')).toBe(10007)
    expect(segmentMaxLength('rating', '评价')).toBe(1314)
    expect(segmentMaxLength('bio', '签名')).toBe(107)
    expect(segmentMaxLength('resource', '标题')).toBe(300)
    expect(segmentMaxLength('resource', '介绍')).toBe(10007)
    expect(segmentMaxLength('resource', '模型型号')).toBe(107)
  })

  it('查不到标签 (引入主体之前的旧任务) 时没有上限', () => {
    expect(segmentMaxLength('resource', '正文')).toBeUndefined()
    expect(segmentMaxLength('comment', '标题')).toBeUndefined()
  })

  // 链接文本、大小、提取码、解压码向所有访客展示, 同样是自由文本 (X09-03)
  it('链接送审链接文本、大小、提取码、解压码, 顺序是链接在前', () => {
    expect(classified(RESOURCE_LINK_FIELD_POLICY, 'audit')).toEqual([
      'content',
      'size',
      'code',
      'password'
    ])
    expect(RESOURCE_LINK_FIELD_POLICY.content).toMatchObject({
      audit: 'plain',
      label: '链接'
    })
    expect(RESOURCE_LINK_FIELD_POLICY.size).toMatchObject({ label: '大小' })
    expect(RESOURCE_LINK_FIELD_POLICY.code).toMatchObject({ label: '提取码' })
    expect(RESOURCE_LINK_FIELD_POLICY.password).toMatchObject({
      label: '解压码'
    })
  })

  it('链接字段的长度上限同样读自写入校验, 带序号的字段名也查得到', () => {
    expect(segmentMaxLength('resource', '链接')).toBe(1007)
    expect(segmentMaxLength('resource', '提取码')).toBe(1007)
    expect(segmentMaxLength('resource', '解压码 10')).toBe(1007)
    expect(segmentMaxLength('resource', '链接 3')).toBe(1007)
  })

  // 「大小」只要求以 MB / GB 结尾, 前面可以是任意 107 个字符, 所以它是自由文本;
  // 它的校验是正则而不是 max(), 上限只能写死, 由这里对着真实 schema 锁住
  it('大小字段的上限恰好容得下校验放行的最长值', () => {
    const linkSchema = patchResourceCreateSchema.shape.links.element
    const link = {
      storage: 'user',
      content: 'https://pan.example/s/abc',
      code: '',
      password: ''
    }
    const longest = `${'加'.repeat(107)}GB`

    expect(linkSchema.safeParse({ ...link, size: longest }).success).toBe(true)
    expect(
      linkSchema.safeParse({ ...link, size: `加${longest}` }).success
    ).toBe(false)
    expect(segmentMaxLength('resource', '大小')).toBe(longest.length)
  })
})

// 提交的链接里哪些是用户填的: 对象存储的地址与新上传文件的大小由服务端写下, 不送审
describe('submittedLinkSubject: 提交的链接 → 送审字段', () => {
  it('外链的四个字段都是用户填的', () => {
    expect(
      submittedLinkSubject({
        id: 3,
        storage: 'user',
        content: 'https://pan.example/s/abc',
        size: '1 GB',
        code: 'c0de',
        password: 'pw'
      })
    ).toEqual({
      storage: 'user',
      content: 'https://pan.example/s/abc',
      size: '1 GB',
      code: 'c0de',
      password: 'pw'
    })
  })

  it('新上传的对象存储链接没有可审的地址与大小, 即使给了库里的旧大小', () => {
    expect(
      submittedLinkSubject(
        { id: 3, storage: 's3', uploadToken: 'tok', code: '', password: 'pw' },
        '100 MB'
      )
    ).toEqual({
      storage: 's3',
      content: '',
      size: '',
      code: '',
      password: 'pw'
    })
  })

  it('沿用原文件的对象存储链接带上库里的大小: 与编辑前的主体对得上', () => {
    const stored = {
      storage: 's3',
      content: 'https://cdn.example/patch/1/resource/seg/a.zip',
      size: '100 MB',
      code: '',
      password: 'pw'
    }
    const kept = submittedLinkSubject(
      { id: 3, storage: 's3', code: '', password: 'pw' },
      stored.size
    )
    const fields = { name: '标题', note: '', modelName: '' }

    expect(kept.size).toBe('100 MB')
    expect(
      subjectChanged(
        resourceSubject({ ...fields, links: [stored] }),
        resourceSubject({ ...fields, links: [kept] })
      )
    ).toBe(false)
  })
})

describe('主体构造器', () => {
  it('评论、评价、签名各一段, 形态决定 worker 走哪条渲染管线', () => {
    expect(commentSubject('**正文**')).toEqual({
      contentType: 'comment',
      segments: [{ label: '评论', kind: 'markdown-comment', value: '**正文**' }]
    })
    expect(ratingSubject('短评')).toEqual({
      contentType: 'rating',
      segments: [{ label: '评价', kind: 'plain', value: '短评' }]
    })
    expect(bioSubject('签名')).toEqual({
      contentType: 'bio',
      segments: [{ label: '签名', kind: 'plain', value: '签名' }]
    })
  })

  it('资源按策略表的顺序出段, 空串字段不出段', () => {
    expect(
      resourceSubject({
        name: 'Patch v1',
        note: '说明',
        modelName: 'GPT',
        links: []
      }).segments
    ).toEqual([
      { label: '标题', kind: 'plain', value: 'Patch v1' },
      { label: '介绍', kind: 'markdown-standard', value: '说明' },
      { label: '模型型号', kind: 'plain', value: 'GPT' }
    ])
    expect(
      resourceSubject({ name: '', note: '说明', modelName: '', links: [] })
        .segments
    ).toEqual([{ label: '介绍', kind: 'markdown-standard', value: '说明' }])
    expect(commentSubject('').segments).toEqual([])
  })

  const external = {
    storage: 'user',
    content: 'https://pan.example/s/abc',
    size: '1 GB',
    code: '',
    password: ''
  }
  const SIZE = { kind: 'plain', value: '1 GB' }
  const withLinks = (links: Array<typeof external>) =>
    resourceSubject({ name: 'T', note: '', modelName: '', links }).segments

  it('单条链接的字段不带序号, 空的提取码与解压码不出段', () => {
    expect(withLinks([external])).toEqual([
      { label: '标题', kind: 'plain', value: 'T' },
      { label: '链接', kind: 'plain', value: 'https://pan.example/s/abc' },
      { label: '大小', ...SIZE }
    ])
  })

  it('多条链接依次编号, 每条的大小、提取码、解压码紧随其后', () => {
    expect(
      withLinks([
        { ...external, code: 'abcd' },
        { ...external, content: 'https://b.example', password: 'pw' }
      ])
    ).toEqual([
      { label: '标题', kind: 'plain', value: 'T' },
      { label: '链接 1', kind: 'plain', value: 'https://pan.example/s/abc' },
      { label: '大小 1', ...SIZE },
      { label: '提取码 1', kind: 'plain', value: 'abcd' },
      { label: '链接 2', kind: 'plain', value: 'https://b.example' },
      { label: '大小 2', ...SIZE },
      { label: '解压码 2', kind: 'plain', value: 'pw' }
    ])
  })

  // 站内存储的链接地址是服务端绑定上传对象时生成的, 不是用户输入; 其余字段仍是
  it('站内存储 (s3) 的链接地址不送审, 大小、提取码与解压码照常送审', () => {
    expect(
      withLinks([
        {
          storage: 's3',
          content: 'https://cdn.example/generated',
          size: '加微信 vx123 代充 GB',
          code: '',
          password: '加群获取'
        }
      ])
    ).toEqual([
      { label: '标题', kind: 'plain', value: 'T' },
      { label: '大小', kind: 'plain', value: '加微信 vx123 代充 GB' },
      { label: '解压码', kind: 'plain', value: '加群获取' }
    ])
  })

  it('保留原始值, 不做降噪改写', () => {
    const raw = '  <加群 987654321>\n\u200Bdata:1;base64,abc  '

    expect(commentSubject(raw).segments[0].value).toBe(raw)
  })

  it('孤立代理替换为 U+FFFD, 否则载荷写不进 jsonb', () => {
    const [segment] = bioSubject('a\uD83Db').segments

    expect(segment.value).toBe('a\uFFFDb')
    expect(segment.value.isWellFormed()).toBe(true)
  })
})

describe('isSubjectEmpty', () => {
  it.each([
    ['没有任何段', commentSubject('')],
    [
      '只有空白',
      resourceSubject({ name: '  ', note: '\n\t', modelName: ' ', links: [] })
    ],
    ['只有不可见字符', bioSubject('\u200B\u3164\uFFF9\uFEFF')]
  ])('%s: 视为空', (_name, subject) => {
    expect(isSubjectEmpty(subject)).toBe(true)
  })

  it('任一段有可见文字即非空', () => {
    expect(
      isSubjectEmpty(
        resourceSubject({ name: ' ', note: '', modelName: 'x', links: [] })
      )
    ).toBe(false)
  })
})

describe('subjectChanged', () => {
  const withSegments = (
    segments: SubjectSegment[]
  ): ModerationSubject<'resource'> => ({ contentType: 'resource', segments })
  const title = { label: '标题', kind: 'plain', value: 'Patch v1' } as const
  const link = {
    label: '链接',
    kind: 'plain',
    value: 'https://a.example'
  } as const

  it('各段原始值逐一相同才算未变化', () => {
    expect(subjectChanged(commentSubject('same'), commentSubject('same'))).toBe(
      false
    )
    expect(subjectChanged(commentSubject('a'), commentSubject('a '))).toBe(true)
  })

  it('字段从空变为非空、或反过来, 都算变化', () => {
    const before = resourceSubject({
      name: 'T',
      note: '',
      modelName: '',
      links: []
    })
    const after = resourceSubject({
      name: 'T',
      note: '',
      modelName: 'GPT',
      links: []
    })

    expect(subjectChanged(before, after)).toBe(true)
    expect(subjectChanged(after, before)).toBe(true)
  })

  it('资源只改链接、大小、提取码或解压码都算变化, 只改非送审字段不算', () => {
    const of = (link: Record<string, string>) =>
      resourceSubject({
        name: 'T',
        note: 'N',
        modelName: '',
        links: [
          {
            storage: 'user',
            content: 'https://a',
            size: '1 GB',
            code: '',
            password: '',
            ...link
          }
        ]
      })

    expect(subjectChanged(of({}), of({ content: 'https://b' }))).toBe(true)
    expect(subjectChanged(of({}), of({ code: 'abcd' }))).toBe(true)
    expect(subjectChanged(of({}), of({ password: 'pw' }))).toBe(true)
    expect(subjectChanged(of({}), of({ size: '加微信 GB' }))).toBe(true)
    // 存储方式是枚举值: 在两种外链之间切换不改变任何送审字段
    expect(subjectChanged(of({}), of({ storage: 'touchgal' }))).toBe(false)
  })

  it('只有链接段变化时同样判为变化', () => {
    expect(
      subjectChanged(
        withSegments([title, link]),
        withSegments([title, { ...link, value: 'https://b.example' }])
      )
    ).toBe(true)
    expect(
      subjectChanged(withSegments([title]), withSegments([title, link]))
    ).toBe(true)
  })

  it('标签或形态不同也算变化', () => {
    expect(
      subjectChanged(
        withSegments([title]),
        withSegments([{ ...title, label: '介绍' }])
      )
    ).toBe(true)
    expect(
      subjectChanged(
        withSegments([title]),
        withSegments([{ ...title, kind: 'markdown-standard' }])
      )
    ).toBe(true)
  })
})
