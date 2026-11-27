import { describe, expect, it } from 'vitest'
import {
  attachUpload,
  discardUpload,
  emptyLink,
  fromResource,
  linkView,
  releasesStoredFile,
  switchStorage,
  toRequest
} from '../linkDraft'
import { resourceFormResolver } from '../resolver'
import type {
  ExternalLinkDraft,
  ResourceFormValues,
  ResourceLinkDraft,
  S3LinkDraft
} from '../linkDraft'
import type { PatchResource } from '~/types/api/patch'

const OBJECT_URL = 'https://bucket.example/patch/10/resource/abc/game.zip'

const resource: PatchResource = {
  id: 7,
  name: '汉化补丁',
  section: 'patch',
  uniqueId: 'abcd1234',
  type: ['manual'],
  language: ['zh-Hans'],
  note: '安装说明',
  platform: ['windows'],
  emulatorType: [],
  modelName: '',
  download: 12,
  links: [
    {
      id: 5,
      storage: 's3',
      size: '100.000 MB',
      code: '',
      password: 'pw',
      hash: 'b3'.repeat(32),
      content: OBJECT_URL,
      sortOrder: 0,
      download: 3
    },
    {
      id: 6,
      storage: 'user',
      size: '2 GB',
      code: 'c0de',
      password: '',
      hash: '',
      content: 'https://pan.example/s/1',
      sortOrder: 1,
      download: 9
    }
  ],
  likeCount: 4,
  isLike: true,
  status: 0,
  userId: 2,
  patchId: 10,
  created: '2026-01-01',
  user: { id: 2, name: 'kun', avatar: '', patchCount: 1, role: 2 }
}

const UPLOAD = { token: 'tok-1', fileName: 'new.zip', size: '5.000 MB' }

const s3Link = (link: ResourceLinkDraft): S3LinkDraft => {
  if (link.storage !== 's3') {
    throw new Error('应为对象存储链接')
  }
  return link
}

const externalLink = (link: ResourceLinkDraft): ExternalLinkDraft => {
  if (link.storage === 's3') {
    throw new Error('应为外链')
  }
  return link
}

describe('fromResource: 编辑表单的初值', () => {
  const values = fromResource(resource)

  it('逐字段取资源信息, 备注也在 (不预填的话保存会把它清空)', () => {
    expect(values).toMatchObject({
      patchId: 10,
      section: 'patch',
      name: '汉化补丁',
      note: '安装说明',
      type: ['manual'],
      language: ['zh-Hans'],
      platform: ['windows'],
      emulatorType: [],
      modelName: ''
    })
  })

  it('读模型的字段不进表单', () => {
    expect(Object.keys(values).sort()).toEqual(
      [
        'emulatorType',
        'language',
        'links',
        'modelName',
        'name',
        'note',
        'patchId',
        'platform',
        'section',
        'type'
      ].sort()
    )
  })

  it('旧缓存里缺模拟器类型与模型型号的资源补成空值', () => {
    const legacy = {
      ...resource,
      emulatorType: undefined,
      modelName: undefined
    } as unknown as PatchResource
    expect(fromResource(legacy)).toMatchObject({
      emulatorType: [],
      modelName: ''
    })
  })

  it('对象存储链接沿用原文件, 地址与大小只留在 origin 里', () => {
    const link = s3Link(values.links[0])
    expect(link).toEqual({
      key: link.key,
      id: 5,
      storage: 's3',
      upload: null,
      code: '',
      password: 'pw',
      origin: { storage: 's3', content: OBJECT_URL, size: '100.000 MB' }
    })
    expect(linkView(link)).toBe('s3-kept')
  })

  it('外链带着自己的地址与大小', () => {
    const link = externalLink(values.links[1])
    expect(link).toMatchObject({
      id: 6,
      storage: 'user',
      content: 'https://pan.example/s/1',
      size: '2 GB',
      code: 'c0de'
    })
    expect(linkView(link)).toBe('external')
  })

  it('每条链接各有一个 key', () => {
    const keys = [...values.links, emptyLink('s3'), emptyLink('user')].map(
      (link) => link.key
    )
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('emptyLink: 新加的链接', () => {
  it('对象存储在等上传', () => {
    const link = emptyLink('s3')
    expect(link).toMatchObject({ storage: 's3', upload: null, origin: null })
    expect(link.id).toBeUndefined()
    expect(linkView(link)).toBe('s3-awaiting-upload')
  })

  it('外链的地址与大小是空串 (受控输入)', () => {
    expect(emptyLink('user')).toMatchObject({
      storage: 'user',
      content: '',
      size: '',
      code: '',
      password: '',
      origin: null
    })
  })
})

describe('switchStorage: 换存储类型', () => {
  const [kept, external] = fromResource(resource).links

  it('P26-01: 对象存储改成外链, 原对象的地址不带过去', () => {
    const next = externalLink(switchStorage(kept, 'user'))
    expect(next.content).toBe('')
    expect(next.size).toBe('')
    expect(next).toMatchObject({ key: kept.key, id: 5, password: 'pw' })
    expect(releasesStoredFile(next)).toBe(true)

    const request = toRequest({ ...fromResource(resource), links: [next] })
    expect(JSON.stringify(request)).not.toContain(OBJECT_URL)
  })

  it('改回对象存储, 回到沿用原文件', () => {
    const back = switchStorage(switchStorage(kept, 'user'), 's3')
    expect(back).toEqual(kept)
    expect(linkView(back)).toBe('s3-kept')
    expect(releasesStoredFile(back)).toBe(false)
  })

  it('离开对象存储时摘掉刚传的文件', () => {
    const [uploaded] = attachUpload([kept], kept.key, UPLOAD)
    const next = switchStorage(uploaded, 'user')
    expect(next).not.toHaveProperty('upload')
    expect(linkView(switchStorage(next, 's3'))).toBe('s3-kept')
  })

  it('外链换到对象存储, 地址与大小不带过去, 等上传', () => {
    const next = switchStorage(external, 's3')
    expect(next).not.toHaveProperty('content')
    expect(next).not.toHaveProperty('size')
    expect(next).toMatchObject({ key: external.key, id: 6, code: 'c0de' })
    expect(linkView(next)).toBe('s3-awaiting-upload')
    expect(releasesStoredFile(next)).toBe(false)
  })

  it('外链之间互换, 用户填的地址与大小原样带着', () => {
    const next = externalLink(switchStorage(external, 'touchgal'))
    expect(next).toMatchObject({
      storage: 'touchgal',
      content: 'https://pan.example/s/1',
      size: '2 GB'
    })
  })

  it('存储类型没变时原样返回', () => {
    expect(switchStorage(kept, 's3')).toBe(kept)
    expect(switchStorage(external, 'user')).toBe(external)
  })
})

describe('attachUpload: 上传结果按 key 写回 (P26-02)', () => {
  const first = emptyLink('s3')
  const second = emptyLink('s3')
  const third = emptyLink('user')

  it('写到发起上传的那条链接上', () => {
    const next = attachUpload([first, second, third], second.key, UPLOAD)
    expect(s3Link(next[1]).upload).toEqual(UPLOAD)
    expect(next[0]).toBe(first)
    expect(next[2]).toBe(third)
    expect(linkView(next[1])).toBe('s3-uploaded')
  })

  it('上传期间排在前面的链接被删: 仍写到原来那条, 不按下标写到别的链接上', () => {
    // 发起时 second 在下标 1; 删掉 first 之后下标 1 上是 third
    const next = attachUpload([second, third], second.key, UPLOAD)
    expect(s3Link(next[0]).upload).toEqual(UPLOAD)
    expect(next[1]).toBe(third)
  })

  it('上传期间这条链接被删: 结果作废, 不多出一项', () => {
    const links = [first, third]
    const next = attachUpload(links, second.key, UPLOAD)
    expect(next).toBe(links)
  })

  it('上传期间这条链接改成了外链: 结果作废', () => {
    const links = [first, switchStorage(second, 'user')]
    expect(attachUpload(links, second.key, UPLOAD)).toBe(links)
  })
})

describe('discardUpload: 移除刚传的文件', () => {
  const [kept] = fromResource(resource).links

  it('原来有文件的链接退回沿用原文件, 原链接不丢', () => {
    const [uploaded] = attachUpload([kept], kept.key, UPLOAD)
    expect(linkView(uploaded)).toBe('s3-uploaded')

    const back = discardUpload(uploaded)
    expect(back).toEqual(kept)
    expect(linkView(back)).toBe('s3-kept')
  })

  it('新加的链接退回等上传', () => {
    const fresh = emptyLink('s3')
    const [uploaded] = attachUpload([fresh], fresh.key, UPLOAD)
    expect(linkView(discardUpload(uploaded))).toBe('s3-awaiting-upload')
  })

  it('没有挂着上传的链接原样返回', () => {
    expect(discardUpload(kept)).toBe(kept)
    const external = emptyLink('user')
    expect(discardUpload(external)).toBe(external)
  })
})

describe('toRequest: 请求体的唯一出口', () => {
  const values = fromResource(resource)

  it('只出请求字段: 草稿的 key、origin、文件名与读模型字段都不带', () => {
    const request = toRequest(values)
    expect(Object.keys(request).sort()).toEqual(
      [
        'emulatorType',
        'language',
        'links',
        'modelName',
        'name',
        'note',
        'patchId',
        'platform',
        'section',
        'type'
      ].sort()
    )
    for (const link of request.links) {
      expect(link).not.toHaveProperty('key')
      expect(link).not.toHaveProperty('origin')
      expect(link).not.toHaveProperty('upload')
      expect(link).not.toHaveProperty('download')
      expect(link).not.toHaveProperty('sortOrder')
    }
  })

  it('沿用原文件的对象存储链接只凭 id 表明身份, 不回传库里的校验码', () => {
    expect(toRequest(values).links[0]).toEqual({
      id: 5,
      storage: 's3',
      hash: '',
      content: '',
      size: '100.000 MB',
      code: '',
      password: 'pw'
    })
  })

  it('挂着上传的对象存储链接带上传 token 与上传得到的大小', () => {
    const links = attachUpload(values.links, values.links[0].key, UPLOAD)
    expect(toRequest({ ...values, links: [...links] }).links[0]).toEqual({
      id: 5,
      storage: 's3',
      hash: 'tok-1',
      content: '',
      size: '5.000 MB',
      code: '',
      password: 'pw'
    })
  })

  it('外链带用户填的地址与大小', () => {
    expect(toRequest(values).links[1]).toEqual({
      id: 6,
      storage: 'user',
      hash: '',
      content: 'https://pan.example/s/1',
      size: '2 GB',
      code: 'c0de',
      password: ''
    })
  })
})

describe('resourceFormResolver: 表单按请求体校验', () => {
  const resolve = (values: ResourceFormValues) =>
    resourceFormResolver(values, undefined, {
      fields: {},
      shouldUseNativeValidation: false
    })

  it('编辑表单的初值通过校验', async () => {
    const values = fromResource(resource)
    const result = await resolve(values)
    expect(result.errors).toEqual({})
    expect(result.values).toBe(values)
  })

  it('新加的对象存储链接没有文件: 错误落在这条链接上', async () => {
    const values = fromResource(resource)
    const result = await resolve({
      ...values,
      links: [...values.links, emptyLink('s3')]
    })
    expect(result.errors.links?.[0]).toBeUndefined()
    expect(result.errors.links?.[2]).toMatchObject({
      hash: { message: '请先上传资源文件' }
    })
  })

  it('外链没填地址: 错误落在它的 content 上', async () => {
    const values = fromResource(resource)
    const result = await resolve({ ...values, links: [emptyLink('user')] })
    expect(result.errors.links?.[0]).toMatchObject({
      content: { message: '请输入资源链接' }
    })
  })
})
