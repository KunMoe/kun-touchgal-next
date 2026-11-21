import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createCampaignMock,
  listCampaignsMock,
  transitionCampaignMock,
  verifyHeaderCookieMock
} = vi.hoisted(() => ({
  createCampaignMock: vi.fn(),
  listCampaignsMock: vi.fn(),
  transitionCampaignMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn()
}))

vi.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

// 命令层替身: 这里只看路由怎样把请求交给 server/mail/campaign, 以及谁进得来
vi.mock('~/server/mail/campaign', () => ({
  createCampaign: createCampaignMock,
  listCampaigns: listCampaignsMock,
  transitionCampaign: transitionCampaignMock
}))

import { GET, POST, PUT } from '~/app/api/admin/mail/route'
import { MAIL_CAMPAIGN_LIST_SIZE } from '~/constants/admin'

type Handler = typeof POST

const call = async (handler: Handler, method: string, body?: unknown) => {
  const response = await handler(
    new Request('http://localhost/api/admin/mail', {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }) as unknown as Parameters<Handler>[0]
  )
  return response.json()
}

const SUPER_ADMIN = { uid: 1, role: 4, name: '鲲' }
const validBody = {
  templateId: 'touchgal',
  variables: { title: ' 停机维护通知 ', content: '<p>今晚维护</p>' }
}

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue(SUPER_ADMIN)
})

describe('POST /api/admin/mail', () => {
  it('只建任务: 把模板、标题、正文与操作者交给 createCampaign, 回任务号', async () => {
    createCampaignMock.mockResolvedValue({ campaignId: 12 })

    await expect(call(POST, 'POST', validBody)).resolves.toEqual({
      campaignId: 12
    })

    expect(createCampaignMock).toHaveBeenCalledExactlyOnceWith(
      {
        templateId: 'touchgal',
        title: '停机维护通知',
        contentHtml: '<p>今晚维护</p>'
      },
      SUPER_ADMIN
    )
  })

  it('已有进行中的任务时把拒绝原因原样回给页面', async () => {
    createCampaignMock.mockResolvedValue(
      '群发任务 #5 还没有结束, 等它发完或取消之后才能再发起'
    )

    await expect(call(POST, 'POST', validBody)).resolves.toBe(
      '群发任务 #5 还没有结束, 等它发完或取消之后才能再发起'
    )
  })

  it.each([
    [
      '没有登记的模板',
      { ...validBody, templateId: 'unknown' },
      '未知的邮件模板'
    ],
    [
      '空标题',
      { ...validBody, variables: { title: '  ', content: '正文' } },
      '邮件标题不能为空'
    ],
    [
      '空正文',
      { ...validBody, variables: { title: '标题', content: '' } },
      '邮件内容不能为空'
    ]
  ])('%s在解析时被拒绝, 不建任务', async (_, body, message) => {
    await expect(call(POST, 'POST', body)).resolves.toBe(message)

    expect(createCampaignMock).not.toHaveBeenCalled()
  })

  it.each([
    ['游客', null, '用户未登录'],
    [
      '普通管理员',
      { uid: 2, role: 3, name: 'admin' },
      '本页面仅超级管理员可访问'
    ]
  ])('%s不能发起群发', async (_, session, message) => {
    verifyHeaderCookieMock.mockResolvedValue(session)

    await expect(call(POST, 'POST', validBody)).resolves.toBe(message)

    expect(createCampaignMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/admin/mail', () => {
  it('列出最近的任务', async () => {
    const campaigns = [{ id: 12, status: 'sending', sent: 300, total: 900 }]
    listCampaignsMock.mockResolvedValue(campaigns)

    await expect(call(GET, 'GET')).resolves.toEqual(campaigns)

    expect(listCampaignsMock).toHaveBeenCalledExactlyOnceWith(
      MAIL_CAMPAIGN_LIST_SIZE
    )
  })

  it('普通管理员看不到', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 2, role: 3, name: 'admin' })

    await expect(call(GET, 'GET')).resolves.toBe('本页面仅超级管理员可访问')

    expect(listCampaignsMock).not.toHaveBeenCalled()
  })
})

describe('PUT /api/admin/mail', () => {
  it.each(['cancel', 'resume'] as const)(
    '把 %s 连同任务号与操作者交给 transitionCampaign',
    async (action) => {
      transitionCampaignMock.mockResolvedValue({})

      await expect(
        call(PUT, 'PUT', { campaignId: '12', action })
      ).resolves.toEqual({})

      expect(transitionCampaignMock).toHaveBeenCalledExactlyOnceWith(
        12,
        action,
        SUPER_ADMIN
      )
    }
  )

  it('任务已经结束时把拒绝原因原样回给页面', async () => {
    transitionCampaignMock.mockResolvedValue('这个群发任务已经结束了')

    await expect(
      call(PUT, 'PUT', { campaignId: 12, action: 'cancel' })
    ).resolves.toBe('这个群发任务已经结束了')
  })

  it.each([
    ['没有这种操作', { campaignId: 12, action: 'restart' }],
    ['任务号不是正整数', { campaignId: 0, action: 'cancel' }],
    ['任务号带小数', { campaignId: 1.5, action: 'cancel' }],
    ['缺任务号', { action: 'cancel' }]
  ])('%s的请求被拒绝', async (_, body) => {
    await expect(call(PUT, 'PUT', body)).resolves.toEqual(expect.any(String))

    expect(transitionCampaignMock).not.toHaveBeenCalled()
  })

  it('普通管理员不能取消或继续', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 2, role: 3, name: 'admin' })

    await expect(
      call(PUT, 'PUT', { campaignId: 12, action: 'cancel' })
    ).resolves.toBe('本页面仅超级管理员可访问')

    expect(transitionCampaignMock).not.toHaveBeenCalled()
  })
})
