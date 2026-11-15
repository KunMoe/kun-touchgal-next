import { describe, expect, it } from 'vitest'
import {
  RESOURCE_FIELD_POLICY,
  RESOURCE_LINK_FIELD_POLICY,
  bioSubject,
  commentSubject,
  isSubjectEmpty,
  ratingSubject,
  resourceSubject,
  subjectChanged
} from '../subject'
import type { ModerationSubject, SubjectSegment } from '../subject'

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
    expect(RESOURCE_FIELD_POLICY.name).toEqual({
      audit: 'plain',
      label: '标题'
    })
    expect(RESOURCE_FIELD_POLICY.note).toEqual({
      audit: 'markdown-standard',
      label: '介绍'
    })
    expect(RESOURCE_FIELD_POLICY.modelName).toEqual({
      audit: 'plain',
      label: '模型型号'
    })
  })

  it('链接的三个自由文本字段已分类, 暂不送审', () => {
    expect(classified(RESOURCE_LINK_FIELD_POLICY, 'audit')).toEqual([])
    expect(classified(RESOURCE_LINK_FIELD_POLICY, 'deferred')).toEqual([
      'code',
      'password',
      'content'
    ])
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
      resourceSubject({ name: 'Patch v1', note: '说明', modelName: 'GPT' })
        .segments
    ).toEqual([
      { label: '标题', kind: 'plain', value: 'Patch v1' },
      { label: '介绍', kind: 'markdown-standard', value: '说明' },
      { label: '模型型号', kind: 'plain', value: 'GPT' }
    ])
    expect(
      resourceSubject({ name: '', note: '说明', modelName: '' }).segments
    ).toEqual([{ label: '介绍', kind: 'markdown-standard', value: '说明' }])
    expect(commentSubject('').segments).toEqual([])
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
    ['只有空白', resourceSubject({ name: '  ', note: '\n\t', modelName: ' ' })],
    ['只有不可见字符', bioSubject('\u200B\u3164\uFFF9\uFEFF')]
  ])('%s: 视为空', (_name, subject) => {
    expect(isSubjectEmpty(subject)).toBe(true)
  })

  it('任一段有可见文字即非空', () => {
    expect(
      isSubjectEmpty(resourceSubject({ name: ' ', note: '', modelName: 'x' }))
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
    const before = resourceSubject({ name: 'T', note: '', modelName: '' })
    const after = resourceSubject({ name: 'T', note: '', modelName: 'GPT' })

    expect(subjectChanged(before, after)).toBe(true)
    expect(subjectChanged(after, before)).toBe(true)
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
