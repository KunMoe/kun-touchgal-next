import { describe, expect, it } from 'vitest'
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
  it('文本任务落库 v2: 只存用户提交的原始段, 不存任何派生文本', () => {
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
      ]
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
    ).toEqual({
      v: 2,
      segments: [{ label: '签名', kind: 'plain', value: '新签名' }],
      bio: '新签名'
    })
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
      name: 'Patch v1'
    })
  })

  it('过渡期任务里双写的旧平铺文本被忽略, 只认原始段', () => {
    expect(
      decode('comment', {
        v: 2,
        segments: [
          { label: '评论', kind: 'markdown-comment', value: 'a <b> c' }
        ],
        text: 'a c'
      })
    ).toEqual({
      contentType: 'comment',
      segments: [{ label: '评论', kind: 'markdown-comment', value: 'a <b> c' }]
    })
  })

  it('v1 (只有降噪后的平铺文本) 解码为单个 plain 段', () => {
    expect(decode('comment', { text: '旧评论' })).toEqual({
      contentType: 'comment',
      segments: [{ label: '正文', kind: 'plain', value: '旧评论' }]
    })
    expect(decode('resource', { text: '标题: A 介绍: B', name: 'A' })).toEqual({
      contentType: 'resource',
      segments: [{ label: '正文', kind: 'plain', value: '标题: A 介绍: B' }],
      name: 'A'
    })
    expect(decode('bio', { text: '签名', bio: '签 名' })).toEqual({
      contentType: 'bio',
      segments: [{ label: '正文', kind: 'plain', value: '签名' }],
      bio: '签 名'
    })
  })

  it('v1 缺 text 或为 null 时没有任何段', () => {
    expect(decode('comment', {})).toEqual({
      contentType: 'comment',
      segments: []
    })
    expect(decode('resource', { text: null, name: null })).toEqual({
      contentType: 'resource',
      segments: []
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
