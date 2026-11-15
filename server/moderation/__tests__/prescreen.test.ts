import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getModerationConfigMock, taskUpdateManyMock, taskCreateMock } =
  vi.hoisted(() => ({
    getModerationConfigMock: vi.fn(),
    taskUpdateManyMock: vi.fn(),
    taskCreateMock: vi.fn()
  }))

vi.mock('~/prisma/index', () => ({
  prisma: {
    moderation_task: { updateMany: taskUpdateManyMock, create: taskCreateMock }
  }
}))

vi.mock('~/server/moderation/config', () => ({
  getModerationConfig: getModerationConfigMock
}))

import { prisma } from '~/prisma/index'
import {
  MODERATION_SKIP,
  enqueueTextModeration,
  planTextModeration,
  preScreenMedia
} from '~/server/moderation/submit'
import type { QueuedModerationPlan } from '~/server/moderation/submit'
import {
  bioSubject,
  commentSubject,
  resourceSubject
} from '~/server/moderation/subject'

beforeEach(() => {
  vi.resetAllMocks()
  getModerationConfigMock.mockResolvedValue({ enabled: true, dryRun: false })
  taskUpdateManyMock.mockResolvedValue({ count: 0 })
  taskCreateMock.mockResolvedValue({ id: 1 })
})

const subject = commentSubject('一段需要审核的正文内容')

describe('审核预筛选角色豁免: 仅超级管理员 (role>=4) 跳过', () => {
  it('role 4 文本预筛直接放行, 不读审核配置', async () => {
    expect(await planTextModeration(subject, { userRole: 4 })).toBe(
      MODERATION_SKIP
    )
    expect(getModerationConfigMock).not.toHaveBeenCalled()
  })

  it('role 3 管理员不豁免, 文本正常送审并拦截, 计划携带主体', async () => {
    expect(await planTextModeration(subject, { userRole: 3 })).toEqual({
      queue: true,
      intercept: true,
      dryRun: false,
      subject
    })
  })

  it('role 4 媒体预筛直接放行, 不读审核配置', async () => {
    expect(await preScreenMedia(4)).toBe(MODERATION_SKIP)
    expect(getModerationConfigMock).not.toHaveBeenCalled()
  })

  it('role 3 管理员媒体预筛正常送审', async () => {
    expect(await preScreenMedia(3)).toEqual({
      queue: true,
      intercept: true,
      dryRun: false
    })
  })

  it('审核开关关闭时任何角色都放行', async () => {
    getModerationConfigMock.mockResolvedValue({ enabled: false, dryRun: false })

    expect(await planTextModeration(subject, { userRole: 1 })).toBe(
      MODERATION_SKIP
    )
  })
})

describe('planTextModeration', () => {
  it('灰度 (dryRun) 时排队但不拦截', async () => {
    getModerationConfigMock.mockResolvedValue({ enabled: true, dryRun: true })

    expect(await planTextModeration(subject, { userRole: 1 })).toEqual({
      queue: true,
      intercept: false,
      dryRun: true,
      subject
    })
  })

  it('送审字段与编辑前相同则不重审, 也不读审核配置', async () => {
    const plan = await planTextModeration(subject, {
      userRole: 1,
      previous: commentSubject('一段需要审核的正文内容')
    })

    expect(plan).toBe(MODERATION_SKIP)
    expect(getModerationConfigMock).not.toHaveBeenCalled()
  })

  it('送审字段有变化则重审', async () => {
    const plan = await planTextModeration(subject, {
      userRole: 1,
      previous: commentSubject('编辑前的正文')
    })

    expect(plan.queue).toBe(true)
  })

  it.each([
    ['空串', ''],
    ['纯空白', ' \n\t '],
    ['只有不可见字符', '\u200B\u3164\uFEFF']
  ])('没有可见文字 (%s) 时不送审, 也不读审核配置', async (_name, text) => {
    expect(await planTextModeration(bioSubject(text), { userRole: 1 })).toBe(
      MODERATION_SKIP
    )
    expect(
      await planTextModeration(
        resourceSubject({ name: text, note: text, modelName: '' }),
        { userRole: 1 }
      )
    ).toBe(MODERATION_SKIP)
    expect(getModerationConfigMock).not.toHaveBeenCalled()
  })

  it('读配置抛错时原样抛出, 调用点须把预筛排在不可回滚的副作用之前', async () => {
    getModerationConfigMock.mockRejectedValue(new Error('redis down'))

    await expect(planTextModeration(subject, { userRole: 1 })).rejects.toThrow(
      'redis down'
    )
  })
})

describe('enqueueTextModeration', () => {
  const queued = <T extends 'comment' | 'resource' | 'bio'>(
    planned: QueuedModerationPlan<T>['subject'],
    dryRun = false
  ): QueuedModerationPlan<T> => ({
    queue: true,
    intercept: !dryRun,
    dryRun,
    subject: planned
  })

  it('先作废同一内容仍在途的任务, 再按计划里的主体建任务', async () => {
    await enqueueTextModeration(prisma, queued(subject), {
      contentId: 12,
      userId: 7
    })

    expect(taskUpdateManyMock).toHaveBeenCalledWith({
      where: { content_type: 'comment', status: 'pending', content_id: 12 },
      data: { status: 'superseded' }
    })
    expect(taskCreateMock).toHaveBeenCalledWith({
      data: {
        content_type: 'comment',
        content_id: 12,
        patch_id: null,
        user_id: 7,
        payload: {
          v: 2,
          segments: [
            {
              label: '评论',
              kind: 'markdown-comment',
              value: '一段需要审核的正文内容'
            }
          ],
          text: '一段需要审核的正文内容'
        },
        dry_run: false
      }
    })
    expect(taskUpdateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      taskCreateMock.mock.invocationCallOrder[0]
    )
  })

  it('资源任务带上拒绝通知要用的资源名与 patch_id', async () => {
    const resource = resourceSubject({
      name: 'Patch v1',
      note: '汉化补丁',
      modelName: ''
    })

    await enqueueTextModeration(prisma, queued(resource), {
      contentId: 5,
      patchId: 10,
      userId: 7,
      name: 'Patch v1'
    })

    expect(taskCreateMock.mock.calls[0][0].data).toMatchObject({
      content_type: 'resource',
      content_id: 5,
      patch_id: 10,
      payload: { v: 2, segments: resource.segments, name: 'Patch v1' }
    })
  })

  it('签名任务按用户归属, 暂存待生效的新签名, 灰度标记取自计划', async () => {
    await enqueueTextModeration(prisma, queued(bioSubject('新签名'), true), {
      userId: 7,
      bio: '新签名'
    })

    expect(taskUpdateManyMock).toHaveBeenCalledWith({
      where: { content_type: 'bio', status: 'pending', user_id: 7 },
      data: { status: 'superseded' }
    })
    expect(taskCreateMock.mock.calls[0][0].data).toMatchObject({
      content_type: 'bio',
      content_id: null,
      user_id: 7,
      payload: { v: 2, bio: '新签名' },
      dry_run: true
    })
  })
})
