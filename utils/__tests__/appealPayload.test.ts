import { describe, expect, it } from 'vitest'
import {
  getAppealEditableLinkFields,
  getResourceAppealFields,
  withUnchangedFields
} from '~/utils/appealPayload'
import { SUPPORTED_RESOURCE_LINK } from '~/constants/resource'
import { RESOURCE_LINK_FIELD_POLICY } from '~/server/moderation/subject'

const link = {
  id: 21,
  storage: 'user',
  content: 'https://pan.example/s/abc',
  size: '1.5 GB',
  code: 'c0de',
  password: 'pw'
}

describe('getAppealEditableLinkFields', () => {
  it('自定义链接四个字段都可改', () => {
    expect(getAppealEditableLinkFields('user')).toEqual([
      'content',
      'size',
      'code',
      'password'
    ])
  })

  it('对象存储的地址不可改, 大小与两个口令可改', () => {
    expect(getAppealEditableLinkFields('s3')).toEqual([
      'size',
      'code',
      'password'
    ])
  })

  // 资源发布 / 编辑路由只允许超级管理员提交 TouchGal 资源盘的链接
  it('TouchGal 资源盘的链接整条不可改', () => {
    expect(getAppealEditableLinkFields('touchgal')).toEqual([])
  })

  it('不认识的存储类型按不可改处理', () => {
    expect(getAppealEditableLinkFields('onedrive')).toEqual([])
    expect(getAppealEditableLinkFields('')).toEqual([])
  })

  // 申诉可改的字段不得超出送审的范围: 送审口径认定不是用户输入的地址, 申诉里也不可改;
  // 可改的字段都必须是策略表里送审的字段
  it('可改字段都在送审策略表之内', () => {
    for (const storage of SUPPORTED_RESOURCE_LINK) {
      const editable = getAppealEditableLinkFields(storage)
      for (const field of editable) {
        expect(typeof RESOURCE_LINK_FIELD_POLICY[field]).toBe('object')
      }
      if (editable.includes('content')) {
        expect(RESOURCE_LINK_FIELD_POLICY.content.when({ storage })).toBe(true)
      }
    }
  })
})

describe('withUnchangedFields', () => {
  const current = { ...link, content: 'https://pan.example/s/current' }

  // 管理员复核时看到的必须是将被写回的那一份
  it('申诉自带链接时以申诉为准', () => {
    expect(
      withUnchangedFields(
        { name: 'n', note: '', links: [link] },
        {
          name: 'o',
          note: '',
          links: [current]
        }
      ).links
    ).toEqual([link])
  })

  it('申诉带的是空链接列表时也不回退', () => {
    expect(
      withUnchangedFields(
        { name: 'n', note: '', links: [] },
        {
          links: [current]
        }
      ).links
    ).toEqual([])
  })

  it('模型型号同理: 申诉自带时以申诉为准, 旧申诉不带时补上现有的', () => {
    const original = { name: 'o', note: '', modelName: 'GPT-旧' }

    expect(
      withUnchangedFields(
        { name: 'n', note: '', modelName: 'DeepSeek-V3' },
        original
      ).modelName
    ).toBe('DeepSeek-V3')
    expect(
      withUnchangedFields({ name: 'n', note: '' }, original).modelName
    ).toBe('GPT-旧')
  })

  it('旧申诉不带链接时补上现有链接, 标题与介绍仍是申诉里的', () => {
    expect(
      withUnchangedFields(
        { name: 'n', note: 'x' },
        {
          name: 'o',
          note: 'y',
          links: [current]
        }
      )
    ).toEqual({ name: 'n', note: 'x', links: [current] })
  })

  it('内容已删除时没有可补的链接', () => {
    expect(withUnchangedFields({ name: 'n', note: 'x' }, null).links).toBe(
      undefined
    )
  })
})

describe('getResourceAppealFields', () => {
  it('只有一条链接时字段名不带序号, 与送审时一致', () => {
    expect(
      getResourceAppealFields({ name: '标题', note: '介绍', links: [link] })
    ).toEqual([
      { label: '标题', value: '标题' },
      { label: '介绍', value: '介绍' },
      { label: '链接', value: 'https://pan.example/s/abc' },
      { label: '大小', value: '1.5 GB' },
      { label: '提取码', value: 'c0de' },
      { label: '解压码', value: 'pw' }
    ])
  })

  it('模型型号排在介绍之后、链接之前, 没有时不出行', () => {
    expect(
      getResourceAppealFields({
        name: '标题',
        note: '介绍',
        modelName: 'DeepSeek-V3',
        links: [link]
      }).map((field) => field.label)
    ).toEqual(['标题', '介绍', '模型型号', '链接', '大小', '提取码', '解压码'])
    expect(
      getResourceAppealFields({ name: '标题', note: '介绍', modelName: '' })
    ).toHaveLength(2)
  })

  it('多条链接时逐条编号, 空的提取码与解压码不出行', () => {
    const fields = getResourceAppealFields({
      name: '标题',
      note: '介绍',
      links: [
        { ...link, code: '', password: '' },
        { ...link, id: 22, password: '' }
      ]
    })

    expect(fields.map((field) => field.label)).toEqual([
      '标题',
      '介绍',
      '链接 1',
      '大小 1',
      '链接 2',
      '大小 2',
      '提取码 2'
    ])
  })

  // 介绍里伪造的字段行只是「介绍」这一个字段的值, 不会变成独立的字段
  it('自由文本里的换行不会产生新的字段', () => {
    const fields = getResourceAppealFields({
      name: '标题',
      note: '正文\n链接：https://fake.example\n大小：1 GB',
      links: [link]
    })

    expect(fields.filter((field) => field.label === '链接')).toEqual([
      { label: '链接', value: 'https://pan.example/s/abc' }
    ])
    expect(fields).toHaveLength(6)
  })

  it('链接字段可申诉之前提交的申诉只有标题与介绍', () => {
    expect(getResourceAppealFields({ name: '标题', note: '介绍' })).toEqual([
      { label: '标题', value: '标题' },
      { label: '介绍', value: '介绍' }
    ])
  })
})
