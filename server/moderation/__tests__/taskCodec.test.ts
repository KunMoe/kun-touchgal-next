import { describe, expect, it } from 'vitest'
import { prepareModerationText } from '../prefilter'
import { bioSubject, commentSubject, resourceSubject } from '../subject'
import { decodeModerationTask, encodeModerationPayload } from '../taskCodec'

const avatarPayload = {
  pendingKey: 'user/avatar/pending.avif',
  pendingMiniKey: 'user/avatar/pending-mini.avif',
  avatarKey: 'user/avatar/avatar.avif',
  avatarMiniKey: 'user/avatar/avatar-mini.avif',
  avatarLink: 'https://img.example/avatar-mini.avif?v=1',
  pendingLink: 'https://img.example/pending-mini.avif'
}

describe('encodeModerationPayload', () => {
  it('文本任务落库 v2: 原始段 + 过渡期双写的旧平铺文本', () => {
    expect(
      encodeModerationPayload({
        contentType: 'comment',
        subject: commentSubject('看这里 <加群 987654321>')
      })
    ).toEqual({
      v: 2,
      segments: [
        {
          label: '评论',
          kind: 'markdown-comment',
          value: '看这里 <加群 987654321>'
        }
      ],
      text: '看这里'
    })
  })

  it('资源带资源名, 签名带待生效的新值', () => {
    expect(
      encodeModerationPayload({
        contentType: 'resource',
        subject: resourceSubject({ name: 'N', note: '', modelName: '' }),
        name: 'N'
      })
    ).toMatchObject({ v: 2, name: 'N' })
    expect(
      encodeModerationPayload({
        contentType: 'bio',
        subject: bioSubject('新签名'),
        bio: '新签名'
      })
    ).toMatchObject({ v: 2, bio: '新签名', text: '新签名' })
  })

  it('附带的资源名与签名里的孤立代理替换为 U+FFFD', () => {
    expect(
      encodeModerationPayload({
        contentType: 'bio',
        subject: bioSubject('a\uD83Db'),
        bio: 'a\uD83Db'
      })
    ).toMatchObject({ bio: 'a\uFFFDb' })
    expect(
      JSON.stringify(
        encodeModerationPayload({
          contentType: 'resource',
          subject: resourceSubject({
            name: 'N\uDE00',
            note: '',
            modelName: ''
          }),
          name: 'N\uDE00'
        })
      )
    ).not.toMatch(/\\ud[89a-f]/i)
  })

  it('头像载荷原样落库', () => {
    expect(
      encodeModerationPayload({ contentType: 'avatar', payload: avatarPayload })
    ).toBe(avatarPayload)
  })

  // 引入主体之前, 资源送审文本由调用点手写模板拼出。双写的 text 必须与它逐字相同,
  // 模型输入与裁决缓存键才不变
  it.each([
    ['只有标题', 'Patch v1', '', ''],
    ['标题与介绍', 'Patch v1', '第一行\n\n第二行', ''],
    ['带模型型号', 'Patch v1', '介绍', 'GPT-4o'],
    ['只有介绍', '', '只有介绍', ''],
    ['只有模型型号', '', '', 'Claude'],
    ['标题是纯空白', '  ', '介绍', ''],
    ['含尖括号与伪 base64', '<b>标题</b>', 'data:1;base64,123 <群>', ''],
    ['介绍超长触发头尾截断', '标题', '字'.repeat(13000), '']
  ])('资源的双写文本与旧模板逐字相同: %s', (_name, name, note, modelName) => {
    const legacy = prepareModerationText(
      `标题: ${name}\n介绍: ${note}${modelName ? `\n模型型号: ${modelName}` : ''}`
    )

    expect(
      encodeModerationPayload({
        contentType: 'resource',
        subject: resourceSubject({ name, note, modelName }),
        name
      })
    ).toMatchObject({ text: legacy })
  })

  it.each([
    ['评论', commentSubject('  多行\n评论 <x>  ')],
    ['签名', bioSubject('个性 签名')]
  ])('单段内容的双写文本就是预处理后的原文: %s', (_name, subject) => {
    expect(
      encodeModerationPayload({
        contentType: subject.contentType,
        subject
      } as Parameters<typeof encodeModerationPayload>[0])
    ).toMatchObject({ text: prepareModerationText(subject.segments[0].value) })
  })
})

describe('decodeModerationTask', () => {
  const decode = (contentType: string, payload: unknown) =>
    decodeModerationTask({ content_type: contentType, payload })

  it('v2 往返: 段与附带值原样读回', () => {
    const subject = resourceSubject({
      name: 'Patch v1',
      note: '介绍',
      modelName: ''
    })
    const payload = JSON.parse(
      JSON.stringify(
        encodeModerationPayload({
          contentType: 'resource',
          subject,
          name: 'Patch v1'
        })
      )
    )

    expect(decode('resource', payload)).toEqual({
      contentType: 'resource',
      segments: subject.segments,
      text: '标题: Patch v1 介绍: 介绍',
      name: 'Patch v1'
    })
  })

  it('v2 缺 text (停止双写之后的任务) 时由段重算旧平铺文本', () => {
    expect(
      decode('resource', {
        v: 2,
        segments: [
          { label: '标题', kind: 'plain', value: 'Patch v1' },
          { label: '模型型号', kind: 'plain', value: 'GPT' }
        ],
        name: 'Patch v1'
      })
    ).toMatchObject({ text: '标题: Patch v1 介绍: 模型型号: GPT' })
    expect(
      decode('comment', {
        v: 2,
        segments: [
          { label: '评论', kind: 'markdown-comment', value: 'a <b> c' }
        ]
      })
    ).toMatchObject({ text: 'a c' })
  })

  it('v1 (只有平铺文本) 解码为单个 plain 段, text 原样保留', () => {
    expect(decode('comment', { text: '旧评论' })).toEqual({
      contentType: 'comment',
      segments: [{ label: '正文', kind: 'plain', value: '旧评论' }],
      text: '旧评论'
    })
    expect(
      decode('resource', { text: '标题: A 介绍: B', name: 'A' })
    ).toMatchObject({ text: '标题: A 介绍: B', name: 'A' })
    expect(decode('bio', { text: '签名', bio: '签 名' })).toMatchObject({
      text: '签名',
      bio: '签 名'
    })
  })

  it('v1 缺 text 或为 null 时按空串处理, 与引入编解码前的 ?? 一致', () => {
    expect(decode('comment', {})).toEqual({
      contentType: 'comment',
      segments: [],
      text: ''
    })
    expect(decode('resource', { text: null, name: null })).toEqual({
      contentType: 'resource',
      segments: [],
      text: ''
    })
  })

  it('头像: archiveLink 可选, 其余键必填', () => {
    expect(decode('avatar', avatarPayload)).toEqual({
      contentType: 'avatar',
      payload: avatarPayload
    })
    expect(
      decode('avatar', { ...avatarPayload, archiveLink: 'https://a.example' })
    ).toMatchObject({ payload: { archiveLink: 'https://a.example' } })
    expect(decode('avatar', { pendingLink: 'only' })).toBeNull()
  })

  it.each([
    ['载荷不是对象', 'comment', 'string'],
    ['载荷为 null', 'comment', null],
    ['text 不是字符串', 'comment', { text: 42 }],
    ['v2 的段损坏, 不得当成空的 v1 放过', 'comment', { v: 2, segments: 'x' }],
    [
      'v2 的段形态未知',
      'comment',
      {
        v: 2,
        segments: [{ label: 'a', kind: 'html', value: 'b' }]
      }
    ],
    ['未知的载荷版本', 'comment', { v: 3, segments: [] }],
    ['未知的 content_type', 'video', { text: 'a' }],
    ['文本载荷套在头像任务上', 'avatar', { text: 'a' }]
  ])('解不出来时返回 null: %s', (_name, contentType, payload) => {
    expect(decode(contentType, payload)).toBeNull()
  })
})
