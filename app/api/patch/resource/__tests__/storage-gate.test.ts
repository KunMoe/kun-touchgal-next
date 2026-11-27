import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  resourceFindUniqueMock,
  resourceCountMock,
  patchFindUniqueMock,
  transactionMock,
  bindUploadedResourceMock,
  hasPendingModerationMock,
  planTextModerationMock
} = vi.hoisted(() => ({
  resourceFindUniqueMock: vi.fn(),
  resourceCountMock: vi.fn(),
  patchFindUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  bindUploadedResourceMock: vi.fn(),
  hasPendingModerationMock: vi.fn(),
  planTextModerationMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_resource: {
      findUnique: resourceFindUniqueMock,
      count: resourceCountMock
    },
    patch: { findUnique: patchFindUniqueMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/patch/resource/_helper', () => ({
  abandonBoundResourceObjects: vi.fn(),
  bindUploadedResource: bindUploadedResourceMock,
  enqueueResourceLinkDeletions: vi.fn(),
  recalcPatchType: vi.fn()
}))

vi.mock('~/app/api/patch/resource/cache', () => ({
  invalidatePatchResourceDetailCache: vi.fn()
}))

vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: vi.fn()
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: vi.fn()
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: vi.fn()
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: vi.fn()
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: vi.fn()
}))

vi.mock('~/app/api/utils/render/renderKunMarkdown', () => ({
  renderKunMarkdownForWrite: vi.fn(async () => ({}))
}))

vi.mock('~/server/moderation/submit', () => ({
  MODERATION_SKIP: { queue: false, intercept: false, dryRun: false },
  enqueueTextModeration: vi.fn(),
  hasPendingModeration: hasPendingModerationMock,
  planTextModeration: planTextModerationMock
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: vi.fn(),
  queueSearchSync: vi.fn()
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  kickS3DeletionDrain: vi.fn()
}))

import { createPatchResource } from '~/app/api/patch/resource/create'
import { updatePatchResource } from '~/app/api/patch/resource/update'
import { linkStorageGateError } from '~/app/api/patch/resource/storageGate'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { RESOURCE_STATUS } from '~/constants/contentStatus'
import type { KunRole } from '~/constants/role'

const TOUCHGAL_ERROR = '仅超级管理员可使用 TouchGal 资源盘'
const S3_ROLE_ERROR = '您的权限不足, 创作者或者管理员才可以上传文件到对象存储'
const S3_SECTION_ERROR =
  '您当前的角色不能在该分区使用对象存储, 请改用自定义链接'
// 闸门之后的下一步是查 Galgame: 让它查不到, 拿到这句就说明闸门放行了
const PASSED_GATE = '未找到该资源对应的 Galgame 信息, 请确认 Galgame 存在'

const AUTHOR_UID = 7

type LinkInput = Parameters<typeof createPatchResource>[0]['links'][number]

// 新提交的链接: 对象存储带着一次上传, 外链带着地址与大小。storage 收字符串是为了能传
// 不认识的存储类型 (校验层会拦下, 这里测的是服务自己的闸门)
const link = (storage: string, id?: number) =>
  ({
    ...(id === undefined ? {} : { id }),
    storage,
    ...(storage === 's3'
      ? { uploadToken: 'upload-token' }
      : { content: 'https://example.com/file', size: '100MB' }),
    code: '',
    password: ''
  }) as LinkInput

const buildInput = (
  section: string,
  links: LinkInput[],
  overrides: Record<string, unknown> = {}
) => ({
  patchId: 10,
  section,
  name: '资源',
  note: '',
  links,
  type: ['manual'],
  language: ['zh-Hans'],
  platform: ['windows'],
  emulatorType: [],
  modelName: '',
  ...overrides
})

const storedLink = (id: number, storage: string) => ({
  id,
  storage,
  hash: storage === 's3' ? 'stored-hash' : '',
  content: 'https://example.com/stored',
  s3_key: storage === 's3' ? 'patch/10/stored' : '',
  size: '100MB',
  code: '',
  password: '',
  sort_order: 0,
  download: 0
})

// 编辑表单原样带回的链接: 对象存储只凭 id (不带上传), 外链与库里那一行逐字段相同
const kept = (id: number, storage: string) => {
  const stored = storedLink(id, storage)
  return {
    id,
    storage,
    ...(storage === 's3' ? {} : { content: stored.content, size: stored.size }),
    code: stored.code,
    password: stored.password
  } as LinkInput
}

const storedResource = (
  section: string,
  links: ReturnType<typeof storedLink>[],
  overrides: Record<string, unknown> = {}
) => ({
  id: 1,
  patch_id: 10,
  user_id: AUTHOR_UID,
  status: RESOURCE_STATUS.public,
  section,
  name: '资源',
  note: '',
  model_name: '',
  links,
  ...overrides
})

// 按前台入口的方式调用: 同一个操作者交给服务与前台守卫
const frontUpdate = (
  input: ReturnType<typeof buildInput>,
  uid: number,
  role: KunRole
) => {
  const actor = kunTestActor({ uid, role })
  return updatePatchResource({ ...input, resourceId: 1 }, actor, 'front')
}

const expectNoSideEffects = () => {
  expect(bindUploadedResourceMock).not.toHaveBeenCalled()
  expect(planTextModerationMock).not.toHaveBeenCalled()
  expect(transactionMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  resourceCountMock.mockResolvedValue(3)
  patchFindUniqueMock.mockResolvedValue(null)
  hasPendingModerationMock.mockResolvedValue(false)
})

describe('linkStorageGateError 拒绝文案', () => {
  const actor = (role: KunRole) => kunTestActor({ uid: AUTHOR_UID, role })

  it('对象存储: 没有上传资格与分区不允许是两句不同的文案', () => {
    expect(
      linkStorageGateError(actor(1), { section: 'patch', links: [link('s3')] })
    ).toBe(S3_ROLE_ERROR)
    expect(
      linkStorageGateError(actor(2), {
        section: 'galgame',
        links: [link('s3')]
      })
    ).toBe(S3_SECTION_ERROR)
  })

  it('TouchGal 资源盘沿用原路由的文案', () => {
    expect(
      linkStorageGateError(actor(3), {
        section: 'galgame',
        links: [link('user'), link('touchgal')]
      })
    ).toBe(TOUCHGAL_ERROR)
  })

  it('不认识的存储类型一律拒绝', () => {
    expect(
      linkStorageGateError(actor(4), { section: 'patch', links: [link('ftp')] })
    ).toBe('非法的资源链接类型')
  })

  it('都允许时返回 null', () => {
    expect(
      linkStorageGateError(actor(4), {
        section: 'galgame',
        links: [link('touchgal'), link('s3'), link('user')]
      })
    ).toBeNull()
  })
})

// 存储 × 分区 × 角色的完整矩阵。与发布表单的置灰是同一组判定, 这里钉的是服务端确实在执法
const MATRIX: Array<[KunRole, string, string, string | null]> = [
  [1, 'patch', 'user', null],
  [1, 'patch', 's3', S3_ROLE_ERROR],
  [1, 'patch', 'touchgal', TOUCHGAL_ERROR],
  [1, 'galgame', 'user', null],
  [1, 'galgame', 's3', S3_ROLE_ERROR],
  [1, 'galgame', 'touchgal', TOUCHGAL_ERROR],
  [2, 'patch', 'user', null],
  [2, 'patch', 's3', null],
  [2, 'patch', 'touchgal', TOUCHGAL_ERROR],
  [2, 'galgame', 'user', null],
  [2, 'galgame', 's3', S3_SECTION_ERROR],
  [2, 'galgame', 'touchgal', TOUCHGAL_ERROR],
  [3, 'patch', 'user', null],
  [3, 'patch', 's3', null],
  [3, 'patch', 'touchgal', TOUCHGAL_ERROR],
  [3, 'galgame', 'user', null],
  [3, 'galgame', 's3', S3_SECTION_ERROR],
  [3, 'galgame', 'touchgal', TOUCHGAL_ERROR],
  [4, 'patch', 'user', null],
  [4, 'patch', 's3', null],
  [4, 'patch', 'touchgal', null],
  [4, 'galgame', 'user', null],
  [4, 'galgame', 's3', null],
  [4, 'galgame', 'touchgal', null]
]

describe('创建资源: 每条链接都按存储 × 分区 × 角色判定', () => {
  it.each(MATRIX)(
    'role %i 在 %s 分区用 %s',
    async (role, section, storage, error) => {
      const result = await createPatchResource(
        buildInput(section, [link(storage)]),
        kunTestActor({ uid: AUTHOR_UID, role })
      )

      if (error) {
        expect(result).toBe(error)
        // 被拒时什么都还没做: 不查库、不绑定上传、不送审、不开事务
        expect(patchFindUniqueMock).not.toHaveBeenCalled()
        expectNoSideEffects()
      } else {
        expect(result).toBe(PASSED_GATE)
      }
    }
  )

  it('多条链接里只要有一条不允许就整体拒绝', async () => {
    const result = await createPatchResource(
      buildInput('patch', [link('user'), link('s3'), link('touchgal')]),
      kunTestActor({ uid: AUTHOR_UID, role: 3 })
    )

    expect(result).toBe(TOUCHGAL_ERROR)
    expectNoSideEffects()
  })
})

describe('更新资源: 只判新增的链接与存储或分区有变化的链接', () => {
  it('管理员能保存含既有 TouchGal 链接的资源 (链接原样带回)', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('galgame', [
        storedLink(5, 'touchgal'),
        storedLink(6, 'user')
      ])
    )

    const result = await frontUpdate(
      buildInput('galgame', [kept(5, 'touchgal'), kept(6, 'user')], {
        name: '改了名字'
      }),
      99,
      3
    )

    expect(result).toBe(PASSED_GATE)
  })

  it.each([1, 2, 3] as const)(
    'role %i 不能在编辑时新增 TouchGal 链接',
    async (role) => {
      resourceFindUniqueMock.mockResolvedValue(
        storedResource('galgame', [storedLink(5, 'touchgal')])
      )

      // role 1、2 只能改自己的资源, 所以以作者身份提交
      const result = await frontUpdate(
        buildInput('galgame', [kept(5, 'touchgal'), link('touchgal')]),
        AUTHOR_UID,
        role
      )

      expect(result).toBe(TOUCHGAL_ERROR)
      expect(patchFindUniqueMock).not.toHaveBeenCalled()
      expectNoSideEffects()
    }
  )

  it('把既有链接换成 TouchGal 存储要判', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('galgame', [storedLink(5, 'user')])
    )

    const result = await frontUpdate(
      buildInput('galgame', [link('touchgal', 5)]),
      99,
      3
    )

    expect(result).toBe(TOUCHGAL_ERROR)
    expectNoSideEffects()
  })

  it('带着库里没有的链接 id 提交按新增判 (不能靠编造 id 冒充存量)', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('galgame', [storedLink(5, 'user')])
    )

    const result = await frontUpdate(
      buildInput('galgame', [kept(5, 'user'), link('touchgal', 404)]),
      99,
      3
    )

    expect(result).toBe(TOUCHGAL_ERROR)
    expectNoSideEffects()
  })

  it.each([2, 3] as const)(
    'role %i 不能把带对象存储的资源从补丁分区搬进 Galgame 分区',
    async (role) => {
      resourceFindUniqueMock.mockResolvedValue(
        storedResource('patch', [storedLink(5, 's3')])
      )

      const result = await frontUpdate(
        buildInput('galgame', [kept(5, 's3')]),
        AUTHOR_UID,
        role
      )

      expect(result).toBe(S3_SECTION_ERROR)
      // 闸门先于 S3 重绑: 被拒时没有任何对象被复制
      expectNoSideEffects()
    }
  )

  it('规则收紧前留下的 Galgame 分区对象存储链接不锁死: 原样保存、搬回补丁分区都放行', async () => {
    const legacy = storedResource('galgame', [storedLink(5, 's3')])
    const keptLinks = [kept(5, 's3')]

    resourceFindUniqueMock.mockResolvedValue(legacy)
    expect(
      await frontUpdate(
        buildInput('galgame', keptLinks, { name: '改了名字' }),
        AUTHOR_UID,
        2
      )
    ).toBe(PASSED_GATE)

    resourceFindUniqueMock.mockResolvedValue(legacy)
    expect(
      await frontUpdate(buildInput('patch', keptLinks), AUTHOR_UID, 2)
    ).toBe(PASSED_GATE)
  })

  it('存量资源里新增的对象存储链接照判', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('galgame', [storedLink(5, 's3')])
    )

    const result = await frontUpdate(
      buildInput('galgame', [kept(5, 's3'), link('s3')]),
      AUTHOR_UID,
      2
    )

    expect(result).toBe(S3_SECTION_ERROR)
    expectNoSideEffects()
  })

  // 「原样带回」才算存量: 归存储所有的字段动过, 或同一行被提交了不止一次, 都按新链接判
  it.each([
    ['地址', { content: 'https://evil.example.com/file' }],
    ['地址 (只多了一个空格)', { content: 'https://example.com/stored ' }],
    ['解压码 (只多了一个空格)', { password: ' ' }],
    ['大小', { size: '999GB' }],
    ['提取码', { code: 'evil' }],
    ['解压码', { password: 'evil' }]
  ])('role 3 不能改既有 TouchGal 链接的%s', async (_label, change) => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('galgame', [storedLink(5, 'touchgal')])
    )

    const result = await frontUpdate(
      buildInput('galgame', [{ ...kept(5, 'touchgal'), ...change }]),
      99,
      3
    )

    expect(result).toBe(TOUCHGAL_ERROR)
    expectNoSideEffects()
  })

  // 校验层会 trim 提取码; 库里不经校验写入的旧值带首尾空白时, 表单带回来的是 trim 过的
  it('库里的提取码带首尾空白: 原样带回仍算存量, 不误拒只改了别处的保存', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('galgame', [
        { ...storedLink(5, 'touchgal'), code: ' abcd\u3000' }
      ])
    )

    const result = await frontUpdate(
      buildInput('galgame', [{ ...kept(5, 'touchgal'), code: 'abcd' }], {
        name: '改了名字'
      }),
      99,
      3
    )

    expect(result).toBe(PASSED_GATE)
  })

  it('同一条既有 TouchGal 链接不能靠重复提交 id 克隆成多条', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('galgame', [storedLink(5, 'touchgal')])
    )

    const result = await frontUpdate(
      buildInput('galgame', [kept(5, 'touchgal'), kept(5, 'touchgal')]),
      99,
      3
    )

    expect(result).toBe(TOUCHGAL_ERROR)
    expectNoSideEffects()
  })

  it.each([2, 3] as const)(
    'role %i 不能给 Galgame 分区的存量对象存储链接换新文件',
    async (role) => {
      resourceFindUniqueMock.mockResolvedValue(
        storedResource('galgame', [storedLink(5, 's3')])
      )

      const result = await frontUpdate(
        buildInput('galgame', [
          { ...kept(5, 's3'), uploadToken: 'new-upload-token' } as LinkInput
        ]),
        AUTHOR_UID,
        role
      )

      expect(result).toBe(S3_SECTION_ERROR)
      // 新的上传没有被绑定: 没有对象落进 Galgame 分区
      expectNoSideEffects()
    }
  )

  it('存量对象存储链接不能靠重复提交 id 多挂几个新上传', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('galgame', [storedLink(5, 's3')])
    )

    const result = await frontUpdate(
      buildInput('galgame', [kept(5, 's3'), kept(5, 's3')]),
      AUTHOR_UID,
      2
    )

    expect(result).toBe(S3_SECTION_ERROR)
    expectNoSideEffects()
  })

  it('存量对象存储链接的提取码、解压码作者仍可改, 不带 uploadToken 就是原对象', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('galgame', [storedLink(5, 's3')])
    )

    const result = await frontUpdate(
      buildInput('galgame', [
        {
          ...kept(5, 's3'),
          code: 'abcd',
          password: 'kun'
        }
      ]),
      AUTHOR_UID,
      2
    )

    expect(result).toBe(PASSED_GATE)
  })

  it('超级管理员不受限 (后台包装与前台入口走的是同一个服务)', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('patch', [storedLink(5, 'user')])
    )

    const result = await frontUpdate(
      buildInput('galgame', [link('touchgal', 5), link('s3'), link('user')]),
      99,
      4
    )

    expect(result).toBe(PASSED_GATE)
  })

  it('归属与状态守卫先于存储闸门: 改不了的资源不透露存储规则', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('galgame', [storedLink(5, 'user')])
    )

    const result = await frontUpdate(
      buildInput('galgame', [link('touchgal')]),
      8,
      2
    )

    expect(result).toBe('您没有权限更改该资源')
  })
})

// 只有 storage 为 s3 的行才算对象的引用: 外链指着桶里的对象, 那一行被删或换了文件之后
// 它就是死链 (P26-01)。规则之前留下的行原样带回不判
describe('外链不许指向本站桶里的对象', () => {
  const BUCKET = 'https://bucket.example'
  const OBJECT_URL = `${BUCKET}/patch/10/resource/abc/game.zip`
  const MANAGED_ERROR =
    '本站对象存储里的文件不能填成外部链接, 请选择「对象存储」并上传文件'

  const external = (
    content: string,
    id?: number,
    storage: 'user' | 'touchgal' = 'user'
  ): LinkInput => ({
    ...(id === undefined ? {} : { id }),
    storage,
    content,
    size: '100MB',
    code: '',
    password: ''
  })

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_KUN_VISUAL_NOVEL_S3_STORAGE_URL', BUCKET)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('发布时外链填了桶里对象的地址: 拒绝, 什么都还没做', async () => {
    const result = await createPatchResource(
      buildInput('patch', [external(OBJECT_URL)]),
      kunTestActor({ uid: AUTHOR_UID, role: 4 })
    )

    expect(result).toBe(MANAGED_ERROR)
    expect(patchFindUniqueMock).not.toHaveBeenCalled()
    expectNoSideEffects()
  })

  it.each([
    ['大小写不同', 'HTTPS://Bucket.Example/patch/10/resource/abc/game.zip'],
    ['前面带空白', `  ${OBJECT_URL}`]
  ])('地址%s也认得出', async (_label, content) => {
    const result = await createPatchResource(
      buildInput('patch', [external(content)]),
      kunTestActor({ uid: AUTHOR_UID, role: 4 })
    )

    expect(result).toBe(MANAGED_ERROR)
  })

  it('别处的地址、只是提到桶域名的地址不拦', async () => {
    const result = await createPatchResource(
      buildInput('patch', [
        external('https://pan.example/s/1'),
        external(`https://redirect.example/?url=${OBJECT_URL}`),
        external('https://bucket.example.evil/patch/1')
      ]),
      kunTestActor({ uid: AUTHOR_UID, role: 4 })
    )

    expect(result).toBe(PASSED_GATE)
  })

  it('P26-01: 把对象存储链接改成外链却留着对象地址, 拒绝且不重绑、不开事务', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('patch', [{ ...storedLink(5, 's3'), content: OBJECT_URL }])
    )

    const result = await frontUpdate(
      buildInput('patch', [external(OBJECT_URL, 5)]),
      AUTHOR_UID,
      2
    )

    expect(result).toBe(MANAGED_ERROR)
    expectNoSideEffects()
  })

  it('把已有外链的地址改成桶里的对象: 拒绝', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('patch', [storedLink(5, 'user')])
    )

    const result = await frontUpdate(
      buildInput('patch', [external(OBJECT_URL, 5)]),
      AUTHOR_UID,
      2
    )

    expect(result).toBe(MANAGED_ERROR)
    expectNoSideEffects()
  })

  it('规则之前留下的这种外链原样带回不判: 不妨碍改别的字段', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('patch', [
        { ...storedLink(5, 'user'), content: OBJECT_URL }
      ])
    )

    const result = await frontUpdate(
      buildInput('patch', [external(OBJECT_URL, 5)], { name: '改了名字' }),
      AUTHOR_UID,
      2
    )

    expect(result).toBe(PASSED_GATE)
  })

  it('存量外链连同存储类型一起换: 按新链接判', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      storedResource('patch', [
        { ...storedLink(5, 'user'), content: OBJECT_URL }
      ])
    )

    const result = await frontUpdate(
      buildInput('patch', [external(OBJECT_URL, 5, 'touchgal')]),
      99,
      4
    )

    expect(result).toBe(MANAGED_ERROR)
  })

  it('对象存储链接自己不在此列', () => {
    expect(
      linkStorageGateError(kunTestActor({ uid: AUTHOR_UID, role: 4 }), {
        section: 'patch',
        links: [link('s3')]
      })
    ).toBeNull()
  })
})
